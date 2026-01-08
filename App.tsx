
import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { ServerItem, LaborItem, Category, Role, Project, TaskStatus, Priority, JournalEntry, JournalEntryType } from './types';
import { INITIAL_SERVERS, INITIAL_LABOR_ITEMS, INITIAL_UNIT_PRICES, INITIAL_LABOR_PRICES, INITIAL_JOURNAL } from './constants';
import { calculateItemCost, calculateLaborCost, formatCurrency, saveProjectToCloud, fetchProjectsFromCloud, deleteProjectFromCloud, exportProjectToExcel, mapStringToRole, downloadImportTemplate } from './utils';
import { analyzeArchitecture, predictTaskMandays } from './geminiService';

type Tab = 'overview' | 'mandays' | 'board' | 'infra' | 'journal' | 'settings';

const PriorityBadge: React.FC<{ priority: Priority }> = ({ priority }) => {
  const colors = {
    [Priority.Low]: 'bg-slate-100 text-slate-600',
    [Priority.Medium]: 'bg-blue-100 text-blue-600',
    [Priority.High]: 'bg-orange-100 text-orange-600',
    [Priority.Urgent]: 'bg-red-100 text-red-600',
  };
  return <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${colors[priority]}`}>{priority}</span>;
};

const NavItem: React.FC<{ id: Tab, label: string, icon: React.ReactNode, activeTab: Tab, onClick: (id: Tab) => void }> = ({ id, label, icon, activeTab, onClick }) => (
  <button
    onClick={() => onClick(id)}
    className={`flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all font-bold text-sm w-full ${activeTab === id ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/20' : 'text-slate-400 hover:bg-slate-800'}`}
  >
    <span>{icon}</span>
    <span>{label}</span>
  </button>
);

const PriceRow: React.FC<{ label: string, value: number, onChange: (val: number) => void, unit?: string }> = ({ label, value, onChange, unit = "VNĐ" }) => (
  <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
    <span className="text-[11px] font-semibold text-slate-500 pr-2">{label}</span>
    <div className="flex items-center gap-2 flex-shrink-0">
      <input type="number" className="w-24 md:w-32 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-black text-right focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all" value={value || 0} onChange={(e) => onChange(parseFloat(e.target.value) || 0)} />
      <span className="text-[9px] text-slate-400 font-bold w-10 uppercase">{unit}</span>
    </div>
  </div>
);

const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isEstimatingAll, setIsEstimatingAll] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showQuotation, setShowQuotation] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const init = async () => {
      try {
        setIsLoading(true);
        const data = await fetchProjectsFromCloud();
        if (data && data.length > 0) {
          setProjects(data);
          setCurrentProjectId(data[0].id);
        } else {
          const first: Project = { id: 'p1', name: 'Dự án Mẫu', servers: INITIAL_SERVERS, labors: INITIAL_LABOR_ITEMS, journal: INITIAL_JOURNAL, infraPrices: INITIAL_UNIT_PRICES, laborPrices: INITIAL_LABOR_PRICES, createdAt: Date.now(), lastModified: Date.now() };
          setProjects([first]);
          setCurrentProjectId('p1');
          await saveProjectToCloud(first);
        }
      } catch (error) { console.error(error); } finally { setIsLoading(false); }
    };
    init();
  }, []);

  const currentProject = useMemo(() => projects.find(p => p.id === currentProjectId) || null, [projects, currentProjectId]);

  const updateProject = (updates: Partial<Project>) => {
    if (!currentProjectId || !currentProject) return;
    const updated = { ...currentProject, ...updates, lastModified: Date.now() };
    setProjects(prev => prev.map(p => p.id === currentProjectId ? updated : p));
  };

  const projectStats = useMemo(() => {
    if (!currentProject) return { progress: 0, todo: 0, doing: 0, review: 0, done: 0, total: 0 };
    const tasks = currentProject.labors;
    const total = tasks.length;
    if (total === 0) return { progress: 0, todo: 0, doing: 0, review: 0, done: 0, total: 0 };
    const done = tasks.filter(t => t.status === TaskStatus.Done).length;
    const review = tasks.filter(t => t.status === TaskStatus.Review).length;
    const doing = tasks.filter(t => t.status === TaskStatus.Doing).length;
    const todo = tasks.filter(t => t.status === TaskStatus.Todo).length;
    return { progress: Math.round((done / total) * 100), todo, doing, review, done, total };
  }, [currentProject]);

  const milestones = useMemo(() => {
    if (!currentProject?.journal) return [];
    return currentProject.journal
      .filter(j => j.type === JournalEntryType.Milestone)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [currentProject]);

  const infraTotal = useMemo(() => currentProject ? (currentProject.servers || []).reduce((sum, s) => sum + calculateItemCost(s, currentProject.infraPrices).totalPrice, 0) : 0, [currentProject]);
  const manualLaborTotal = useMemo(() => currentProject ? (currentProject.labors || []).reduce((sum, l) => sum + calculateLaborCost(l, currentProject.laborPrices), 0) : 0, [currentProject]);
  
  // Logic 1:3: 3 Dev thì 1 PM, 1 QC, 1 BA
  const autoLaborStats = useMemo(() => {
    if (!currentProject) return { pm: 0, ba: 0, qc: 0, devTotal: 0 };
    const devMandays = currentProject.labors
      .filter(l => l.role === Role.SeniorDev || l.role === Role.JuniorDev)
      .reduce((sum, l) => sum + (l.mandays || 0), 0);
    const ratio = 1 / 3;
    return { 
      devTotal: devMandays, 
      pm: devMandays * ratio, 
      ba: devMandays * ratio, 
      qc: devMandays * ratio 
    };
  }, [currentProject]);
  
  const autoLaborTotal = useMemo(() => {
    if (!currentProject) return 0;
    const lp = currentProject.laborPrices;
    return (autoLaborStats.pm * (lp[Role.PM] || 0)) + 
           (autoLaborStats.ba * (lp[Role.BA] || 0)) + 
           (autoLaborStats.qc * (lp[Role.QC] || 0));
  }, [currentProject, autoLaborStats]);
  
  const grandTotal = infraTotal + manualLaborTotal + autoLaborTotal;

  const handleNavItemClick = (id: Tab) => { setActiveTab(id); setIsSidebarOpen(false); };
  
  const handleSaveProject = async () => { 
    if (!currentProject) return; 
    setIsSyncing(true); 
    try { 
      await saveProjectToCloud(currentProject); 
      alert("Đã lưu thành công!"); 
    } catch (e) { alert("Lỗi lưu Cloud."); } finally { setIsSyncing(false); } 
  };

  const handleNewProject = () => {
    const id = 'p' + Date.now();
    const newProj: Project = { id, name: 'Dự án mới', servers: [], labors: [], journal: [], infraPrices: INITIAL_UNIT_PRICES, laborPrices: INITIAL_LABOR_PRICES, createdAt: Date.now(), lastModified: Date.now() };
    setProjects([newProj, ...projects]);
    setCurrentProjectId(id);
  };

  const handleDuplicateProject = () => {
    if (!currentProject) return;
    const id = 'p-copy-' + Date.now();
    const copy: Project = { ...currentProject, id, name: `${currentProject.name} (Bản sao)`, createdAt: Date.now(), lastModified: Date.now() };
    setProjects([copy, ...projects]);
    setCurrentProjectId(id);
    alert("Đã nhân bản dự án!");
  };

  const handleDeleteProject = async (id: string) => {
    if (!window.confirm("Bạn có chắc chắn muốn xóa dự án này?")) return;
    try {
      await deleteProjectFromCloud(id);
      const updated = projects.filter(p => p.id !== id);
      setProjects(updated);
      if (currentProjectId === id) setCurrentProjectId(updated.length > 0 ? updated[0].id : null);
    } catch (e) { alert("Lỗi xóa dự án."); }
  };

  const handleImportExcel = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data: any[] = XLSX.utils.sheet_to_json(ws);
      const importedTasks: LaborItem[] = data.map((row, idx) => ({
        id: `l-imp-${Date.now()}-${idx}`,
        taskName: row['Đầu việc'] || 'Task imported',
        description: row['Mô tả'] || '',
        role: mapStringToRole(row['Vai trò']),
        mandays: parseFloat(row['Số công (MD)'] || row['Số công']) || 1,
        status: TaskStatus.Todo,
        priority: Priority.Medium,
        assignee: '',
        dueDate: ''
      }));
      if (importedTasks.length > 0) {
        updateProject({ labors: [...currentProject.labors, ...importedTasks] });
        alert(`Đã nhập thành công ${importedTasks.length} công việc!`);
      }
    };
    reader.readAsBinaryString(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleEstimateAll = async () => {
    if (!currentProject) return;
    setIsEstimatingAll(true);
    try {
      const updatedLabors = await Promise.all(
        currentProject.labors.map(async (l) => {
          if (l.mandays > 1) return l;
          const estimated = await predictTaskMandays(l.taskName, l.description, l.role);
          return estimated !== null ? { ...l, mandays: estimated } : l;
        })
      );
      updateProject({ labors: updatedLabors });
    } catch (error) { console.error(error); } finally { setIsEstimatingAll(false); }
  };

  const handleAddJournal = (type: JournalEntryType) => {
    if (!currentProject) return;
    const newEntry: JournalEntry = { id: 'j' + Date.now(), type, date: new Date().toISOString().split('T')[0], title: type === JournalEntryType.Meeting ? 'Cuộc họp mới' : 'Mốc quan trọng mới', content: '' };
    updateProject({ journal: [newEntry, ...(currentProject.journal || [])] });
  };

  if (isLoading || !currentProject) return <div className="min-h-screen bg-[#0F172A] flex flex-col items-center justify-center text-white font-black tracking-widest">
    <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
    ĐANG TẢI DỮ LIỆU HỆ THỐNG...
  </div>;

  // QUOTATION VIEW COMPONENT
  if (showQuotation) {
    return (
      <div className="min-h-screen bg-white text-slate-900 p-8 md:p-16 print:p-0 font-sans max-w-5xl mx-auto shadow-2xl animate-in fade-in duration-500">
        <div className="flex justify-between items-start mb-12 print:hidden">
           <button onClick={() => setShowQuotation(false)} className="flex items-center gap-2 text-indigo-600 font-bold hover:bg-indigo-50 px-4 py-2 rounded-xl transition-all">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
              Quay lại chỉnh sửa
           </button>
           <button onClick={() => window.print()} className="bg-indigo-600 text-white px-8 py-2 rounded-xl font-black shadow-lg shadow-indigo-200 flex items-center gap-2 hover:bg-indigo-500 transition-all">
              In Báo Giá (PDF)
           </button>
        </div>

        <div id="quotation-content" className="border-t-8 border-indigo-600 pt-12">
           <div className="flex justify-between mb-16">
              <div>
                 <h1 className="text-4xl font-black text-slate-800 tracking-tighter mb-2 uppercase">Báo Giá Dự Án</h1>
                 <p className="text-slate-400 font-bold text-sm tracking-widest uppercase">Mã báo giá: #{currentProject.id.toUpperCase()}</p>
              </div>
              <div className="text-right">
                 <h2 className="text-xl font-black text-indigo-600">EstimaCore Consulting</h2>
                 <p className="text-xs text-slate-500 font-bold">Ngày lập: {new Date().toLocaleDateString('vi-VN')}</p>
              </div>
           </div>

           <div className="mb-12">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4 border-b pb-2">Thông tin Dự án</h3>
              <p className="text-2xl font-black text-slate-800">{currentProject.name}</p>
           </div>

           {currentProject.servers.length > 0 && (
             <div className="mb-12">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">I. CHI TIẾT HẠ TẦNG CLOUD</h3>
                <table className="w-full text-left">
                   <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-500">
                      <tr><th className="p-3">Dịch vụ</th><th className="p-3 text-center">Số lượng</th><th className="p-3 text-right">Thành tiền</th></tr>
                   </thead>
                   <tbody>
                      {currentProject.servers.map(s => {
                        const cost = calculateItemCost(s, currentProject.infraPrices);
                        return (
                          <tr key={s.id} className="border-b border-slate-100 text-xs">
                             <td className="p-3 font-bold">{s.content}</td>
                             <td className="p-3 text-center">{s.quantity}</td>
                             <td className="p-3 text-right font-bold">{formatCurrency(cost.totalPrice)}</td>
                          </tr>
                        );
                      })}
                   </tbody>
                </table>
             </div>
           )}

           <div className="mb-12">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">II. CHI TIẾT NHÂN SỰ</h3>
              <table className="w-full text-left">
                 <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-500">
                    <tr><th className="p-3">Vai trò</th><th className="p-3 text-center">Khối lượng (MD)</th><th className="p-3 text-right">Thành tiền</th></tr>
                 </thead>
                 <tbody>
                    {Object.values(Role).map(role => {
                      const tasks = currentProject.labors.filter(l => l.role === role);
                      let md = tasks.reduce((s, t) => s + t.mandays, 0);
                      if (role === Role.PM) md += autoLaborStats.pm;
                      if (role === Role.BA) md += autoLaborStats.ba;
                      if (role === Role.QC) md += autoLaborStats.qc;
                      if (md <= 0) return null;
                      return (
                        <tr key={role} className="border-b border-slate-100 text-xs">
                           <td className="p-3 font-bold">{role}</td>
                           <td className="p-3 text-center">{md.toFixed(1)}</td>
                           <td className="p-3 text-right font-bold">{formatCurrency(md * (currentProject.laborPrices[role] || 0))}</td>
                        </tr>
                      );
                    })}
                 </tbody>
              </table>
           </div>

           <div className="bg-slate-900 text-white p-8 rounded-3xl flex justify-between items-center mt-12">
              <div>
                 <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">TỔNG CHI PHÍ DỰ TOÁN (TCO)</p>
              </div>
              <div className="text-right">
                 <p className="text-4xl font-black text-indigo-400 tracking-tighter">{formatCurrency(grandTotal)}</p>
              </div>
           </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col md:flex-row overflow-hidden font-sans">
      {/* SIDEBAR */}
      <aside className={`fixed inset-y-0 left-0 w-72 bg-[#0F172A] text-white z-[70] transition-transform md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} flex flex-col h-screen shadow-2xl`}>
        <div className="p-6 overflow-y-auto flex-1">
          <div className="flex items-center justify-between mb-8">
            <span className="font-black text-2xl tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">EstimaCore</span>
            <button onClick={() => setIsSidebarOpen(false)} className="md:hidden text-slate-400">×</button>
          </div>
          
          <nav className="space-y-1 mb-10">
            <NavItem id="overview" label="Tổng quan" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16m-7 6h7" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="mandays" label="Kế hoạch & Dự toán" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="board" label="Thực thi (Board)" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="journal" label="Nhật ký & Mốc" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="infra" label="Hạ tầng Cloud" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="settings" label="Thiết lập" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
          </nav>

          <div className="pt-6 border-t border-slate-800">
             <div className="flex items-center justify-between mb-4">
                <p className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Danh mục dự án</p>
                <button onClick={handleNewProject} className="text-indigo-400 hover:text-white transition-all text-xs font-bold">+ Mới</button>
             </div>
             <div className="space-y-1">
                {projects.map(p => (
                  <div key={p.id} className={`group flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-all ${currentProjectId === p.id ? 'bg-slate-800' : 'hover:bg-slate-900'}`} onClick={() => setCurrentProjectId(p.id)}>
                     <span className={`text-xs font-bold truncate ${currentProjectId === p.id ? 'text-white' : 'text-slate-400'}`}>{p.name}</span>
                     {projects.length > 1 && (
                       <button onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }} className="opacity-0 group-hover:opacity-100 text-red-400 text-[10px]">×</button>
                     )}
                  </div>
                ))}
             </div>
          </div>
        </div>
        
        <div className="p-6 bg-slate-900/50">
          <button onClick={handleDuplicateProject} className="w-full py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-bold transition-all mb-2">Nhân bản dự án</button>
          <button onClick={handleSaveProject} disabled={isSyncing} className="w-full py-2 bg-indigo-600 rounded-lg text-xs font-bold transition-all hover:bg-indigo-500 shadow-lg shadow-indigo-900/40">
            {isSyncing ? "Đang lưu..." : "Lưu dự án Cloud"}
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-20 bg-white border-b border-slate-200 px-8 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 text-slate-600">
               <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16m-7 6h7" /></svg>
            </button>
            <input value={currentProject.name} onChange={(e) => updateProject({ name: e.target.value })} className="text-xl font-black bg-transparent border-none outline-none w-80 focus:ring-2 focus:ring-indigo-100 rounded-lg px-2" placeholder="Tên dự án..." />
          </div>
          <div className="flex items-center gap-3">
             <button onClick={() => setShowQuotation(true)} className="px-4 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-black hover:bg-indigo-100 transition-all">XUẤT BÁO GIÁ</button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 bg-slate-50/50">
          {activeTab === 'overview' && (
            <div className="space-y-8 animate-in fade-in duration-500">
               <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                     <span className="text-slate-400 font-bold text-[10px] uppercase">Ngân sách dự kiến</span>
                     <p className="text-2xl font-black text-indigo-600 mt-1">{formatCurrency(grandTotal)}</p>
                  </div>
                  <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                     <span className="text-slate-400 font-bold text-[10px] uppercase">Tiến độ thực thi</span>
                     <p className="text-2xl font-black text-emerald-600 mt-1">{projectStats.progress}%</p>
                  </div>
                  <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                     <span className="text-slate-400 font-bold text-[10px] uppercase">Tổng nhân sự (MD)</span>
                     <p className="text-2xl font-black text-amber-600 mt-1">{(manualLaborTotal/manualLaborTotal ? (currentProject.labors.reduce((s,l)=>s+l.mandays,0)) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.qc : 0).toFixed(1)}</p>
                  </div>
                  <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                     <span className="text-slate-400 font-bold text-[10px] uppercase">Hạ tầng Cloud</span>
                     <p className="text-2xl font-black text-slate-800 mt-1">{currentProject.servers.length} VM</p>
                  </div>
               </div>
               
               <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-xl">
                     <h4 className="font-black text-lg mb-6">Lịch trình & Mốc quan trọng</h4>
                     <div className="space-y-6">
                        {milestones.length > 0 ? milestones.map((m) => (
                          <div key={m.id} className="flex gap-4">
                             <div className="w-1 bg-indigo-500 rounded-full"></div>
                             <div>
                                <p className="text-[10px] font-black text-slate-400 uppercase">{new Date(m.date).toLocaleDateString('vi-VN')}</p>
                                <h5 className="text-sm font-bold text-slate-800">{m.title}</h5>
                             </div>
                          </div>
                        )) : <p className="text-xs text-slate-400 italic">Chưa có mốc quan trọng nào.</p>}
                     </div>
                  </div>
                  <div className="bg-indigo-600 p-8 rounded-[40px] text-white shadow-2xl">
                     <h4 className="font-black text-lg mb-4">AI Project Advisor</h4>
                     <p className="text-xs text-indigo-100 mb-6">{analysis || "Nhấn nút để AI phân tích toàn bộ hạ tầng và nhân sự dự án của bạn."}</p>
                     <button onClick={async () => { setIsAnalyzing(true); setAnalysis(await analyzeArchitecture(currentProject.servers, currentProject.labors)); setIsAnalyzing(false); }} className="w-full bg-white text-indigo-600 py-3 rounded-2xl text-xs font-black transition-all active:scale-95">
                        {isAnalyzing ? "Đang xử lý dữ liệu..." : "Bắt đầu Phân tích AI"}
                     </button>
                  </div>
               </div>
            </div>
          )}

          {activeTab === 'mandays' && (
            <div className="space-y-6 animate-in fade-in duration-500 pb-20">
               <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                  <h3 className="font-black text-2xl text-slate-800 tracking-tight">Kế hoạch dự toán nhân sự</h3>
                  <div className="flex flex-wrap gap-2">
                     <button onClick={downloadImportTemplate} className="bg-slate-100 text-slate-600 px-4 py-2 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all">Tải mẫu Excel</button>
                     <input type="file" ref={fileInputRef} onChange={handleImportExcel} className="hidden" accept=".xlsx,.xls" />
                     <button onClick={() => fileInputRef.current?.click()} className="bg-white text-indigo-600 border border-indigo-100 px-4 py-2 rounded-xl text-xs font-bold hover:bg-indigo-50 transition-all">Nhập Task Excel</button>
                     <button onClick={handleEstimateAll} disabled={isEstimatingAll} className="bg-amber-100 text-amber-700 px-4 py-2 rounded-xl text-xs font-bold hover:bg-amber-200 transition-all">{isEstimatingAll ? "Đang tính..." : "AI Ước lượng"}</button>
                     <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Task mới', role: Role.JuniorDev, mandays: 1, description: '', status: TaskStatus.Todo, priority: Priority.Medium, assignee: '', dueDate: '' }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold shadow-lg hover:bg-indigo-500">+ Thêm Task</button>
                  </div>
               </div>
               <div className="bg-white rounded-[32px] border border-slate-200 shadow-xl overflow-hidden">
                  <table className="w-full text-left">
                     <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                        <tr><th className="px-6 py-4 w-1/4">Tên Task / Vai trò</th><th className="px-6 py-4 w-1/3">Mô tả chi tiết</th><th className="px-6 py-4 text-center w-32">Công (MD)</th><th className="px-6 py-4 text-right w-40">Chi phí</th><th className="px-6 py-4 w-16"></th></tr>
                     </thead>
                     <tbody>
                        {currentProject.labors.map(l => (
                          <tr key={l.id} className="border-b border-slate-50 text-xs hover:bg-slate-50 transition-all group">
                             <td className="px-6 py-4">
                                <input className="w-full bg-transparent font-bold outline-none mb-1 focus:text-indigo-600" value={l.taskName} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, taskName: e.target.value} : item)})} />
                                <select className="text-[9px] font-bold text-slate-400 bg-transparent outline-none" value={l.role} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, role: e.target.value as Role} : item)})}>
                                   {Object.values(Role).map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                             </td>
                             <td className="px-6 py-4"><textarea rows={1} className="w-full bg-transparent text-[10px] text-slate-500 resize-none outline-none focus:text-slate-900" value={l.description} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, description: e.target.value} : item)})} /></td>
                             <td className="px-6 py-4 text-center"><input type="number" step="0.5" className="w-16 text-center bg-slate-100 rounded-lg py-1 font-black" value={l.mandays} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, mandays: parseFloat(e.target.value) || 0} : item)})} /></td>
                             <td className="px-6 py-4 text-right font-black">{formatCurrency(calculateLaborCost(l, currentProject.laborPrices))}</td>
                             <td className="px-6 py-4 text-right"><button onClick={() => updateProject({ labors: currentProject.labors.filter(item => item.id !== l.id)})} className="text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all">×</button></td>
                          </tr>
                        ))}
                        {autoLaborStats.devTotal > 0 && (
                          <>
                             <tr className="bg-slate-50/50"><td colSpan={5} className="px-6 py-2 text-[9px] font-black text-slate-400 uppercase tracking-widest border-y border-slate-100">Chi phí gián tiếp (Tự động 1:3 dựa trên Dev)</td></tr>
                             <tr className="bg-indigo-50/30 italic text-xs border-b border-slate-100">
                                <td className="px-6 py-4 font-bold text-indigo-600">Project Manager / EM</td>
                                <td className="px-6 py-4 text-[10px] text-slate-400">Điều hành dự án & Giao tiếp khách hàng</td>
                                <td className="px-6 py-4 text-center font-bold">{autoLaborStats.pm.toFixed(1)}</td>
                                <td className="px-6 py-4 text-right font-black">{formatCurrency(autoLaborStats.pm * (currentProject.laborPrices[Role.PM] || 0))}</td>
                                <td></td>
                             </tr>
                             <tr className="bg-indigo-50/30 italic text-xs border-b border-slate-100">
                                <td className="px-6 py-4 font-bold text-indigo-600">Business Analyst</td>
                                <td className="px-6 py-4 text-[10px] text-slate-400">Phân tích & Quản lý yêu cầu nghiệp vụ</td>
                                <td className="px-6 py-4 text-center font-bold">{autoLaborStats.ba.toFixed(1)}</td>
                                <td className="px-6 py-4 text-right font-black">{formatCurrency(autoLaborStats.ba * (currentProject.laborPrices[Role.BA] || 0))}</td>
                                <td></td>
                             </tr>
                             <tr className="bg-indigo-50/30 italic text-xs border-b border-slate-100">
                                <td className="px-6 py-4 font-bold text-indigo-600">Quality Control (QC)</td>
                                <td className="px-6 py-4 text-[10px] text-slate-400">Kiểm thử chất lượng & Quy trình</td>
                                <td className="px-6 py-4 text-center font-bold">{autoLaborStats.qc.toFixed(1)}</td>
                                <td className="px-6 py-4 text-right font-black">{formatCurrency(autoLaborStats.qc * (currentProject.laborPrices[Role.QC] || 0))}</td>
                                <td></td>
                             </tr>
                          </>
                        )}
                     </tbody>
                  </table>
               </div>
            </div>
          )}

          {activeTab === 'board' && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 h-full pb-10 animate-in fade-in duration-500">
               {[TaskStatus.Todo, TaskStatus.Doing, TaskStatus.Review, TaskStatus.Done].map(status => (
                 <div key={status} className="flex flex-col gap-4">
                    <div className="flex items-center justify-between px-2">
                       <h4 className="font-black text-xs uppercase text-slate-500 flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${status === TaskStatus.Todo ? 'bg-slate-300' : status === TaskStatus.Doing ? 'bg-indigo-500' : status === TaskStatus.Review ? 'bg-amber-400' : 'bg-emerald-500'}`}></div>
                          {status}
                       </h4>
                       <span className="bg-slate-200 text-slate-600 text-[10px] px-2 py-0.5 rounded-full font-black">{currentProject.labors.filter(t => t.status === status).length}</span>
                    </div>
                    <div className="flex-1 space-y-4 min-h-[500px] bg-slate-200/30 p-4 rounded-3xl border border-slate-200/50 overflow-y-auto max-h-[calc(100vh-250px)]">
                       {currentProject.labors.filter(t => t.status === status).map(task => (
                         <div key={task.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 group hover:shadow-md transition-all">
                            <div className="flex justify-between items-start mb-3">
                               <PriorityBadge priority={task.priority} />
                               <select className="text-[9px] font-bold bg-slate-100 rounded outline-none cursor-pointer" value={task.status} onChange={(e) => updateProject({ labors: currentProject.labors.map(t => t.id === task.id ? {...t, status: e.target.value as TaskStatus} : t)})}>
                                  {Object.values(TaskStatus).map(s => <option key={s} value={s}>{s}</option>)}
                               </select>
                            </div>
                            <h5 className="font-bold text-xs text-slate-800 mb-2 leading-snug">{task.taskName}</h5>
                            <p className="text-[10px] text-slate-400 line-clamp-2">{task.description || "Không có mô tả."}</p>
                            <div className="flex items-center justify-between mt-4">
                               <input className="text-[10px] text-slate-400 bg-transparent border-none outline-none w-24 focus:text-indigo-600 font-bold" placeholder="Gán người..." value={task.assignee} onChange={(e) => updateProject({ labors: currentProject.labors.map(t => t.id === task.id ? {...t, assignee: e.target.value} : t)})} />
                               <span className="text-[10px] font-black text-indigo-400">{task.mandays} MD</span>
                            </div>
                         </div>
                       ))}
                       <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Task mới', role: Role.JuniorDev, mandays: 1, description: '', status: status, priority: Priority.Medium, assignee: '', dueDate: '' }] })} className="w-full py-3 border-2 border-dashed border-slate-200 rounded-2xl text-[10px] font-black text-slate-400 hover:border-indigo-300 hover:text-indigo-500 transition-all">+ Task mới</button>
                    </div>
                 </div>
               ))}
            </div>
          )}

          {activeTab === 'journal' && (
            <div className="space-y-6 animate-in fade-in duration-500 pb-20">
               <div className="flex justify-between items-center">
                  <h3 className="font-black text-2xl text-slate-800 tracking-tight">Nhật ký dự án</h3>
                  <div className="flex gap-2">
                     <button onClick={() => handleAddJournal(JournalEntryType.Meeting)} className="bg-indigo-50 text-indigo-600 px-4 py-2 rounded-xl text-xs font-bold hover:bg-indigo-100 transition-all">+ Họp Team</button>
                     <button onClick={() => handleAddJournal(JournalEntryType.Milestone)} className="bg-amber-50 text-amber-600 px-4 py-2 rounded-xl text-xs font-bold hover:bg-amber-100 transition-all">+ Mốc quan trọng</button>
                  </div>
               </div>
               <div className="space-y-6">
                  {(currentProject.journal || []).map((entry) => (
                    <div key={entry.id} className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm relative group">
                       <button onClick={() => updateProject({ journal: currentProject.journal?.filter(j => j.id !== entry.id) })} className="absolute top-4 right-4 text-red-300 opacity-0 group-hover:opacity-100 transition-all font-bold">Xóa</button>
                       <div className="flex items-center gap-3 mb-4">
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${entry.type === JournalEntryType.Milestone ? 'bg-amber-100 text-amber-600' : 'bg-indigo-100 text-indigo-600'}`}>{entry.type}</span>
                          <input type="date" className="text-[10px] font-bold text-slate-400 bg-transparent outline-none" value={entry.date} onChange={(e) => updateProject({ journal: currentProject.journal?.map(j => j.id === entry.id ? {...j, date: e.target.value} : j) })} />
                       </div>
                       <input className="text-sm font-black text-slate-800 w-full bg-transparent border-none outline-none mb-2 focus:text-indigo-600" value={entry.title} onChange={(e) => updateProject({ journal: currentProject.journal?.map(j => j.id === entry.id ? {...j, title: e.target.value} : j) })} />
                       <textarea rows={2} className="text-xs text-slate-500 w-full bg-slate-50 p-4 rounded-2xl border-none outline-none resize-none focus:bg-white focus:ring-1 focus:ring-indigo-100" value={entry.content} onChange={(e) => updateProject({ journal: currentProject.journal?.map(j => j.id === entry.id ? {...j, content: e.target.value} : j) })} />
                    </div>
                  ))}
               </div>
            </div>
          )}

          {activeTab === 'infra' && (
            <div className="space-y-6 animate-in fade-in duration-500">
               <div className="flex justify-between items-center">
                 <h3 className="font-black text-2xl text-slate-800 tracking-tight">Hạ tầng Cloud</h3>
                 <button onClick={() => updateProject({ servers: [...currentProject.servers, { id: 's'+Date.now(), category: Category.AppServer, os: 'Linux', configRaw: '4 core 8GB storage: 100GB', quantity: 1, content: 'Server mới', note: '', storageType: 'diskSanAllFlash', bwQt: 0, bwInternal: 0 }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold shadow-lg hover:bg-indigo-500">+ Thêm VM</button>
               </div>
               <div className="bg-white rounded-[32px] border border-slate-200 shadow-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                    <tr><th className="px-6 py-4">VM / Service</th><th className="px-6 py-4">Cấu hình</th><th className="px-6 py-4 text-center">SL</th><th className="px-6 py-4 text-right">Chi phí/Tháng</th><th className="px-6 py-4 w-16"></th></tr>
                  </thead>
                  <tbody>
                    {currentProject.servers.map(s => {
                      const cost = calculateItemCost(s, currentProject.infraPrices);
                      return (
                        <tr key={s.id} className="border-b border-slate-50 text-xs hover:bg-slate-50 transition-all group">
                          <td className="px-6 py-4 font-bold"><input className="bg-transparent w-full outline-none focus:text-indigo-600" value={s.content} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, content: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4"><input className="w-full bg-slate-100 p-2 rounded-xl text-[10px] outline-none focus:bg-white focus:ring-1 focus:ring-indigo-100" value={s.configRaw} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, configRaw: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4 text-center"><input type="number" className="w-12 text-center bg-slate-100 rounded-lg py-1 font-bold" value={s.quantity} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, quantity: parseInt(e.target.value) || 1} : item)})} /></td>
                          <td className="px-6 py-4 text-right font-black text-indigo-600">{formatCurrency(cost.totalPrice)}</td>
                          <td className="px-6 py-4 text-right"><button onClick={() => updateProject({ servers: currentProject.servers.filter(item => item.id !== s.id)})} className="text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all">×</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-8 animate-in fade-in duration-500 pb-20">
               <div className="bg-white p-10 rounded-[40px] border border-slate-200 shadow-xl">
                 <h3 className="text-2xl font-black mb-8 text-slate-800">Cấu hình Đơn giá (Unit Prices)</h3>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                   <div className="space-y-6">
                     <p className="text-xs font-black text-indigo-600 uppercase tracking-widest">Hạ tầng Cloud (VND/Tháng)</p>
                     <PriceRow label="vCPU" value={currentProject.infraPrices.cpu} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, cpu: v}})} />
                     <PriceRow label="RAM (GB)" value={currentProject.infraPrices.ram} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, ram: v}})} />
                     <PriceRow label="SSD All Flash (1GB)" value={currentProject.infraPrices.diskSanAllFlash} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, diskSanAllFlash: v}})} />
                   </div>
                   <div className="space-y-6">
                     <p className="text-xs font-black text-emerald-600 uppercase tracking-widest">Nhân lực (VND/Manday)</p>
                     {Object.values(Role).map(r => (
                       <PriceRow key={r} label={r} value={currentProject.laborPrices[r] || 0} onChange={(v) => updateProject({ laborPrices: {...currentProject.laborPrices, [r]: v}})} unit="VND" />
                     ))}
                   </div>
                 </div>
              </div>
            </div>
          )}
        </div>

        <footer className="h-20 bg-[#0F172A] text-white px-8 flex items-center justify-between shrink-0 shadow-2xl relative z-20">
          <div className="flex gap-10">
            <div className="hidden sm:block">
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Tổng công</p>
              <p className="text-xl font-black text-indigo-400">{(manualLaborTotal/manualLaborTotal ? (currentProject.labors.reduce((s,l)=>s+l.mandays,0)) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.qc : 0).toFixed(1)} <span className="text-xs text-slate-500">MD</span></p>
            </div>
            <div className="border-l border-slate-800 pl-10 hidden md:block">
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Khởi tạo</p>
              <p className="text-sm font-bold">{new Date(currentProject.createdAt).toLocaleDateString('vi-VN')}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[8px] text-indigo-400 font-bold uppercase tracking-widest mb-0.5">TỔNG CHI PHÍ DỰ TOÁN (TCO)</p>
            <p className="text-2xl font-black tracking-tight">{formatCurrency(grandTotal)}</p>
          </div>
        </footer>
      </main>
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
      `}} />
    </div>
  );
};

export default App;
