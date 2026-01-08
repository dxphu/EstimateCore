
import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { ServerItem, LaborItem, Category, Role, Project, TaskStatus, Priority, JournalEntry, JournalEntryType } from './types';
import { INITIAL_SERVERS, INITIAL_LABOR_ITEMS, INITIAL_UNIT_PRICES, INITIAL_LABOR_PRICES, INITIAL_JOURNAL } from './constants';
import { calculateItemCost, calculateLaborCost, formatCurrency, saveProjectToCloud, fetchProjectsFromCloud, deleteProjectFromCloud, checkSupabaseConnection, generateDeploymentScript, exportProjectToExcel, mapStringToRole, downloadImportTemplate, getCloudConfig, saveCloudConfig, resetSupabaseInstance } from './utils';
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

const StatusBadge: React.FC<{ status: TaskStatus }> = ({ status }) => {
  const colors = {
    [TaskStatus.Todo]: 'bg-slate-100 text-slate-500',
    [TaskStatus.Doing]: 'bg-indigo-100 text-indigo-600',
    [TaskStatus.Review]: 'bg-amber-100 text-amber-600',
    [TaskStatus.Done]: 'bg-emerald-100 text-emerald-600',
  };
  return <span className={`px-2 py-1 rounded-lg text-[10px] font-bold ${colors[status]}`}>{status}</span>;
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
  
  const autoLaborStats = useMemo(() => {
    if (!currentProject) return { pm: 0, ba: 0, tester: 0, devTotal: 0 };
    const devMandays = currentProject.labors.filter(l => l.role === Role.SeniorDev || l.role === Role.JuniorDev).reduce((sum, l) => sum + (l.mandays || 0), 0);
    const ratio = 1 / 3;
    return { 
      devTotal: devMandays, 
      pm: devMandays * ratio, 
      ba: devMandays * ratio, 
      tester: devMandays * ratio 
    };
  }, [currentProject]);
  
  const autoLaborTotal = useMemo(() => {
    if (!currentProject) return 0;
    const lp = currentProject.laborPrices;
    return (autoLaborStats.pm * (lp[Role.PM] || 0)) + (autoLaborStats.ba * (lp[Role.BA] || 0)) + (autoLaborStats.tester * (lp[Role.Tester] || 0));
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
    await deleteProjectFromCloud(id);
    const updated = projects.filter(p => p.id !== id);
    setProjects(updated);
    if (currentProjectId === id) setCurrentProjectId(updated.length > 0 ? updated[0].id : null);
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
    ĐANG TẢI DỮ LIỆU...
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
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
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
                 <p className="text-xs text-slate-500">Dự kiến thực hiện: {currentProject.startDate || 'TBD'} - {currentProject.endDate || 'TBD'}</p>
              </div>
           </div>

           <div className="mb-12">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4 border-b pb-2">Thông tin khách hàng / Dự án</h3>
              <p className="text-2xl font-black text-slate-800">{currentProject.name}</p>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">Báo giá này bao gồm chi tiết về hạ tầng đám mây (Cloud Infrastructure) và nguồn lực nhân sự (Labor Resources) cần thiết để triển khai dự án theo yêu cầu.</p>
           </div>

           {/* INFRA SECTION */}
           {currentProject.servers.length > 0 && (
             <div className="mb-12">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4 flex justify-between items-center">
                   <span>I. CHI TIẾT HẠ TẦNG CLOUD (HÀNG THÁNG)</span>
                   <span className="text-slate-800">{formatCurrency(infraTotal)} / Tháng</span>
                </h3>
                <table className="w-full text-left">
                   <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-500">
                      <tr>
                         <th className="p-3">Dịch vụ & Cấu hình</th>
                         <th className="p-3 text-center">Số lượng</th>
                         <th className="p-3 text-right">Đơn giá</th>
                         <th className="p-3 text-right">Thành tiền</th>
                      </tr>
                   </thead>
                   <tbody>
                      {currentProject.servers.map(s => {
                        const cost = calculateItemCost(s, currentProject.infraPrices);
                        return (
                          <tr key={s.id} className="border-b border-slate-100 text-xs">
                             <td className="p-3">
                                <div className="font-bold">{s.content}</div>
                                <div className="text-[10px] text-slate-400">{s.configRaw}</div>
                             </td>
                             <td className="p-3 text-center">{s.quantity}</td>
                             <td className="p-3 text-right">{formatCurrency(cost.unitPrice)}</td>
                             <td className="p-3 text-right font-bold">{formatCurrency(cost.totalPrice)}</td>
                          </tr>
                        );
                      })}
                   </tbody>
                </table>
             </div>
           )}

           {/* LABOR SECTION */}
           <div className="mb-12">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4 flex justify-between items-center">
                 <span>II. CHI TIẾT NGUỒN LỰC NHÂN SỰ</span>
                 <span className="text-slate-800">{formatCurrency(manualLaborTotal + autoLaborTotal)}</span>
              </h3>
              <table className="w-full text-left">
                 <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-500">
                    <tr>
                       <th className="p-3">Vai trò chuyên môn</th>
                       <th className="p-3 text-center">Khối lượng (MD)</th>
                       <th className="p-3 text-right">Đơn giá/Ngày</th>
                       <th className="p-3 text-right">Thành tiền</th>
                    </tr>
                 </thead>
                 <tbody>
                    {/* Manual Labors grouped by Role */}
                    {Object.values(Role).map(role => {
                      const tasks = currentProject.labors.filter(l => l.role === role);
                      let md = tasks.reduce((s, t) => s + t.mandays, 0);
                      
                      // Add auto stats
                      if (role === Role.PM) md += autoLaborStats.pm;
                      if (role === Role.BA) md += autoLaborStats.ba;
                      if (role === Role.Tester) md += autoLaborStats.tester;

                      if (md <= 0) return null;

                      return (
                        <tr key={role} className="border-b border-slate-100 text-xs">
                           <td className="p-3 font-bold">{role}</td>
                           <td className="p-3 text-center">{md.toFixed(1)}</td>
                           <td className="p-3 text-right">{formatCurrency(currentProject.laborPrices[role] || 0)}</td>
                           <td className="p-3 text-right font-bold">{formatCurrency(md * (currentProject.laborPrices[role] || 0))}</td>
                        </tr>
                      );
                    })}
                 </tbody>
              </table>
           </div>

           {/* SUMMARY */}
           <div className="bg-slate-900 text-white p-8 rounded-3xl flex flex-col md:flex-row justify-between items-center">
              <div>
                 <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">TỔNG CHI PHÍ DỰ TOÁN (TCO)</p>
                 <p className="text-xs text-slate-500">Bao gồm toàn bộ hạ tầng & nhân sự triển khai</p>
              </div>
              <div className="text-right mt-4 md:mt-0">
                 <p className="text-4xl font-black text-indigo-400 tracking-tighter">{formatCurrency(grandTotal)}</p>
                 <p className="text-[10px] text-slate-400 mt-2 italic">Bằng chữ: (Số tiền đã bao gồm các khoản thuế phí liên quan)</p>
              </div>
           </div>

           <div className="mt-16 grid grid-cols-2 gap-20">
              <div>
                 <h4 className="text-xs font-black text-slate-800 uppercase mb-4">Điều khoản & Ghi chú:</h4>
                 <ul className="text-[10px] text-slate-500 space-y-2 list-disc pl-4 leading-relaxed">
                    <li>Báo giá có giá trị trong vòng 30 ngày kể từ ngày lập.</li>
                    <li>Chi phí hạ tầng có thể thay đổi tùy theo biến động tỷ giá và thực tế sử dụng.</li>
                    <li>Lịch trình thực hiện sẽ được chốt sau khi ký hợp đồng chính thức.</li>
                 </ul>
              </div>
              <div className="text-center pt-8 border-t border-slate-100">
                 <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-12">Xác nhận phê duyệt</p>
                 <div className="w-40 h-px bg-slate-200 mx-auto mb-2"></div>
                 <p className="text-[10px] font-bold text-slate-800">Người đại diện có thẩm quyền</p>
              </div>
           </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            body { background: white !important; }
            .print\\:hidden { display: none !important; }
            #quotation-content { border-top: none !important; padding-top: 0 !important; }
            shadow-2xl { box-shadow: none !important; }
          }
        `}} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col md:flex-row overflow-hidden font-sans">
      {/* SIDEBAR */}
      <aside className={`fixed inset-y-0 left-0 w-72 bg-[#0F172A] text-white z-[70] transition-transform md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} flex flex-col h-screen shadow-2xl`}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-8">
            <span className="font-black text-2xl tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">EstimaCore</span>
          </div>
          
          <nav className="space-y-1 mb-10">
            <NavItem id="overview" label="Tổng quan" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16m-7 6h7" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="mandays" label="Kế hoạch & Dự toán" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="board" label="Thực thi (Board)" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="journal" label="Nhật ký & Mốc" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="infra" label="Hạ tầng Cloud" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="settings" label="Thiết lập" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
          </nav>

          <div className="flex-1 flex flex-col min-h-0">
             <div className="flex items-center justify-between mb-3 px-2">
                <p className="text-[10px] uppercase text-slate-500 font-bold tracking-widest">Dự án của tôi</p>
                <button onClick={handleNewProject} className="text-indigo-400 hover:text-white transition-all">
                   <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 4v16m8-8H4" /></svg>
                </button>
             </div>
             <div className="space-y-1 overflow-y-auto max-h-[300px] scrollbar-thin scrollbar-thumb-slate-700">
                {projects.map(p => (
                  <div key={p.id} className={`group flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-all ${currentProjectId === p.id ? 'bg-slate-800 border-l-2 border-indigo-400' : 'hover:bg-slate-900'}`} onClick={() => setCurrentProjectId(p.id)}>
                     <div className="flex flex-col min-w-0">
                        <span className={`text-xs font-bold truncate ${currentProjectId === p.id ? 'text-white' : 'text-slate-400'}`}>{p.name}</span>
                        <span className="text-[9px] text-slate-600 font-medium">{new Date(p.lastModified).toLocaleDateString()}</span>
                     </div>
                  </div>
                ))}
             </div>
          </div>
        </div>
        
        <div className="mt-auto p-6 bg-slate-900/50">
          <div className="mb-4">
             <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] font-bold text-slate-400">Tiến độ thực thi</span>
                <span className="text-[10px] font-bold text-indigo-400">{projectStats.progress}%</span>
             </div>
             <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                <div className="bg-indigo-500 h-full transition-all duration-500" style={{ width: `${projectStats.progress}%` }}></div>
             </div>
          </div>
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
            <div className="flex flex-col">
               <input value={currentProject.name} onChange={(e) => updateProject({ name: e.target.value })} className="text-xl font-black bg-transparent border-none outline-none w-80 focus:ring-2 focus:ring-indigo-100 rounded-lg px-2" placeholder="Tên dự án..." />
               <span className="text-[10px] text-slate-400 font-bold ml-2">ID: {currentProject.id}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
             <button onClick={() => setShowQuotation(true)} className="px-4 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-black hover:bg-indigo-100 transition-all flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                XUẤT BÁO GIÁ
             </button>
             <button onClick={() => exportProjectToExcel(currentProject)} className="px-4 py-2 bg-emerald-50 text-emerald-600 rounded-xl text-xs font-black hover:bg-emerald-100 transition-all flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Báo cáo Excel
             </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 bg-slate-50/50">
          {activeTab === 'overview' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                 <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm flex flex-col justify-between">
                    <span className="text-slate-400 font-bold text-[10px] uppercase">Tổng ngân sách dự kiến</span>
                    <p className="text-2xl font-black text-indigo-600 mt-1">{formatCurrency(grandTotal)}</p>
                 </div>
                 <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm flex flex-col justify-between">
                    <span className="text-slate-400 font-bold text-[10px] uppercase">Lịch trình dự án</span>
                    <div className="mt-2 space-y-1">
                       <div className="flex justify-between text-[10px]">
                          <span className="text-slate-400">Khởi động:</span>
                          <input type="date" value={currentProject.startDate || ''} onChange={(e) => updateProject({ startDate: e.target.value })} className="bg-transparent font-bold text-indigo-500 outline-none" />
                       </div>
                       <div className="flex justify-between text-[10px]">
                          <span className="text-slate-400">Kết thúc:</span>
                          <input type="date" value={currentProject.endDate || ''} onChange={(e) => updateProject({ endDate: e.target.value })} className="bg-transparent font-bold text-indigo-500 outline-none" />
                       </div>
                    </div>
                 </div>
                 <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm flex flex-col justify-between">
                    <span className="text-slate-400 font-bold text-[10px] uppercase">Nhân sự thực thi</span>
                    <p className="text-2xl font-black text-amber-600 mt-1">{((currentProject.labors.reduce((s,l)=>s+l.mandays,0)) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.tester).toFixed(1)} MD</p>
                 </div>
                 <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm flex flex-col justify-between">
                    <span className="text-slate-400 font-bold text-[10px] uppercase">Tài nguyên Hạ tầng</span>
                    <p className="text-2xl font-black text-slate-800 mt-1">{currentProject.servers.length} VM</p>
                 </div>
              </div>
              
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-6">
                   <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-xl relative overflow-hidden">
                      <div className="flex justify-between items-center mb-6">
                         <h4 className="font-black text-lg">Tiến độ công việc</h4>
                         <span className="text-xs font-black text-indigo-600">{projectStats.done} / {projectStats.total} Task hoàn thành</span>
                      </div>
                      <div className="space-y-6">
                         <div className="w-full h-4 bg-slate-100 rounded-full overflow-hidden flex">
                            <div className="bg-emerald-500 h-full transition-all duration-700" style={{ width: `${(projectStats.done / (projectStats.total || 1)) * 100}%` }}></div>
                            <div className="bg-amber-400 h-full transition-all duration-700" style={{ width: `${(projectStats.review / (projectStats.total || 1)) * 100}%` }}></div>
                            <div className="bg-indigo-500 h-full transition-all duration-700" style={{ width: `${(projectStats.doing / (projectStats.total || 1)) * 100}%` }}></div>
                            <div className="bg-slate-300 h-full transition-all duration-700" style={{ width: `${(projectStats.todo / (projectStats.total || 1)) * 100}%` }}></div>
                         </div>
                         <div className="grid grid-cols-4 gap-4">
                            <div className="text-center">
                               <p className="text-[10px] font-black text-slate-400 uppercase mb-1">Cần làm</p>
                               <p className="text-sm font-black text-slate-600">{projectStats.todo}</p>
                            </div>
                            <div className="text-center">
                               <p className="text-[10px] font-black text-indigo-600 uppercase mb-1">Đang làm</p>
                               <p className="text-sm font-black text-indigo-600">{projectStats.doing}</p>
                            </div>
                            <div className="text-center">
                               <p className="text-[10px] font-black text-amber-500 uppercase mb-1">Kiểm tra</p>
                               <p className="text-sm font-black text-amber-600">{projectStats.review}</p>
                            </div>
                            <div className="text-center">
                               <p className="text-[10px] font-black text-emerald-500 uppercase mb-1">Xong</p>
                               <p className="text-sm font-black text-emerald-600">{projectStats.done}</p>
                            </div>
                         </div>
                      </div>
                   </div>

                   <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-xl relative overflow-hidden">
                      <h4 className="font-black text-lg mb-6">Lộ trình & Mốc quan trọng</h4>
                      <div className="space-y-6">
                        {milestones.length > 0 ? (
                          milestones.slice(0, 4).map((m, idx) => (
                            <div key={m.id} className="flex gap-4 group">
                               <div className="flex flex-col items-center">
                                  <div className="w-3 h-3 rounded-full bg-amber-500 border-2 border-white shadow-sm ring-2 ring-amber-100"></div>
                                  {idx !== milestones.slice(0, 4).length - 1 && <div className="w-0.5 flex-1 bg-slate-100 my-1"></div>}
                               </div>
                               <div className="pb-4">
                                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">{new Date(m.date).toLocaleDateString('vi-VN', { day: 'numeric', month: 'short' })}</p>
                                  <h5 className="text-xs font-black text-slate-800 mt-0.5">{m.title}</h5>
                                  <p className="text-[10px] text-slate-400 line-clamp-1 mt-1">{m.content || 'Không có mô tả'}</p>
                               </div>
                            </div>
                          ))
                        ) : (
                          <div className="text-center py-6">
                             <p className="text-[10px] text-slate-400 italic">Chưa có mốc quan trọng nào được thiết lập.</p>
                          </div>
                        )}
                      </div>
                   </div>
                </div>

                <div className="space-y-6">
                   <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-xl">
                      <h4 className="font-black text-lg mb-6">Phân bổ ngân sách</h4>
                      <div className="flex justify-center mb-6">
                        <div className="relative w-32 h-32">
                          <svg className="w-full h-full transform -rotate-90" viewBox="0 0 36 36">
                            <circle cx="18" cy="18" r="16" fill="none" className="stroke-indigo-100" strokeWidth="4"></circle>
                            <circle cx="18" cy="18" r="16" fill="none" className="stroke-indigo-600" strokeWidth="4" 
                              strokeDasharray={`${(infraTotal / (grandTotal || 1)) * 100} 100`}></circle>
                          </svg>
                          <div className="absolute inset-0 flex items-center justify-center flex-col">
                             <span className="text-[10px] font-black text-slate-400">Infra</span>
                             <span className="text-xs font-black text-slate-800">{Math.round((infraTotal / (grandTotal || 1)) * 100)}%</span>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-3">
                         <div className="flex items-center justify-between text-[10px]">
                            <span className="flex items-center gap-1.5 font-bold text-slate-500"><div className="w-2 h-2 rounded-full bg-indigo-600"></div> Hạ tầng</span>
                            <span className="font-black">{formatCurrency(infraTotal)}</span>
                         </div>
                         <div className="flex items-center justify-between text-[10px]">
                            <span className="flex items-center gap-1.5 font-bold text-slate-500"><div className="w-2 h-2 rounded-full bg-amber-500"></div> Nhân sự</span>
                            <span className="font-black">{formatCurrency(manualLaborTotal + autoLaborTotal)}</span>
                         </div>
                      </div>
                   </div>

                   <div className="bg-indigo-600 p-8 rounded-[40px] text-white shadow-2xl relative overflow-hidden">
                      <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-500 rounded-full blur-2xl opacity-50"></div>
                      <h4 className="font-black text-lg mb-2 relative z-10">AI Advisor</h4>
                      <p className="text-xs text-indigo-100 mb-6 leading-relaxed relative z-10">Phân tích dự toán & hạ tầng.</p>
                      <button onClick={async () => { setIsAnalyzing(true); setAnalysis(await analyzeArchitecture(currentProject.servers, currentProject.labors)); setIsAnalyzing(false); }} className="w-full bg-white text-indigo-600 py-3 rounded-2xl text-xs font-black hover:bg-indigo-50 transition-all">
                        {isAnalyzing ? "Đang xử lý..." : "Phân tích dự án"}
                      </button>
                   </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'mandays' && (
            <div className="space-y-6 animate-in fade-in duration-500 pb-20">
              <div className="flex justify-between items-center">
                <h3 className="font-black text-2xl tracking-tight text-slate-800">Kế hoạch & Dự toán Chi tiết</h3>
                <div className="flex gap-2">
                  <input type="file" ref={fileInputRef} onChange={handleImportExcel} className="hidden" accept=".xlsx,.xls" />
                  <button onClick={() => fileInputRef.current?.click()} className="bg-white text-indigo-600 border border-indigo-100 px-4 py-2 rounded-xl text-xs font-bold hover:bg-indigo-50 flex items-center gap-2 transition-all">
                     Nhập Excel
                  </button>
                  <button onClick={handleEstimateAll} disabled={isEstimatingAll} className="bg-amber-100 text-amber-700 px-4 py-2 rounded-xl text-xs font-bold hover:bg-amber-200 transition-all">
                    {isEstimatingAll ? "AI Đang tính..." : "AI Ước lượng"}
                  </button>
                  <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Công việc mới', role: Role.JuniorDev, mandays: 1, description: '', status: TaskStatus.Todo, priority: Priority.Medium, assignee: '', dueDate: '' }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold hover:bg-indigo-500 transition-all">+ Thêm Task</button>
                </div>
              </div>
              
              <div className="bg-white rounded-[32px] border border-slate-200 shadow-xl overflow-hidden">
                <table className="w-full text-left table-fixed">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                    <tr>
                      <th className="px-6 py-4 w-1/4">Đầu việc / Vai trò</th>
                      <th className="px-6 py-4 w-1/3">Mô tả chi tiết</th>
                      <th className="px-6 py-4 text-center w-32">Số công (MD)</th>
                      <th className="px-6 py-4 text-right w-40">Chi phí dự toán</th>
                      <th className="px-6 py-4 w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentProject.labors.map(l => (
                      <tr key={l.id} className="border-b border-slate-50 group hover:bg-slate-50/50 transition-colors">
                        <td className="px-6 py-4">
                           <input className="w-full bg-transparent font-bold text-xs outline-none mb-1" value={l.taskName} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, taskName: e.target.value} : item)})} />
                           <select className="text-[10px] bg-slate-100 px-2 py-0.5 rounded border-none font-bold text-slate-500" value={l.role} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, role: e.target.value as Role} : item)})}>
                             {Object.values(Role).map(r => <option key={r} value={r}>{r}</option>)}
                           </select>
                        </td>
                        <td className="px-6 py-4">
                           <textarea rows={1} className="w-full bg-transparent text-[11px] outline-none text-slate-500 resize-none" value={l.description} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, description: e.target.value} : item)})} />
                        </td>
                        <td className="px-6 py-4 text-center">
                          <input type="number" step="0.5" className="w-16 text-center bg-slate-100 rounded-lg py-1 text-xs font-bold outline-none" value={l.mandays} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, mandays: parseFloat(e.target.value) || 0} : item)})} />
                        </td>
                        <td className="px-6 py-4 text-right font-black text-slate-700 text-xs">{formatCurrency(calculateLaborCost(l, currentProject.laborPrices))}</td>
                        <td className="px-6 py-4 text-right"><button onClick={() => updateProject({ labors: currentProject.labors.filter(item => item.id !== l.id)})} className="text-red-400 opacity-0 group-hover:opacity-100 font-bold hover:scale-125 transition-all">×</button></td>
                      </tr>
                    ))}
                    {autoLaborStats.devTotal > 0 && (
                      <>
                        <tr className="bg-slate-50/80"><td colSpan={5} className="px-6 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest border-y border-slate-100">Chi phí quản lý & QA (Tự động 1:3)</td></tr>
                        <tr className="border-b border-slate-50 bg-indigo-50/20 italic">
                          <td className="px-6 py-4 font-bold text-xs text-indigo-600">PM / EM</td>
                          <td className="px-6 py-4 text-[10px] text-slate-400">Giám sát thực thi</td>
                          <td className="px-6 py-4 text-center font-bold text-xs">{autoLaborStats.pm.toFixed(1)}</td>
                          <td className="px-6 py-4 text-right font-black text-slate-500 text-xs">{formatCurrency(autoLaborStats.pm * (currentProject.laborPrices[Role.PM] || 0))}</td>
                          <td></td>
                        </tr>
                        <tr className="border-b border-slate-50 bg-indigo-50/20 italic">
                          <td className="px-6 py-4 font-bold text-xs text-indigo-600">BA / Tester</td>
                          <td className="px-6 py-4 text-[10px] text-slate-400">QA & Phân tích</td>
                          <td className="px-6 py-4 text-center font-bold text-xs">{(autoLaborStats.ba + autoLaborStats.tester).toFixed(1)}</td>
                          <td className="px-6 py-4 text-right font-black text-slate-500 text-xs">{formatCurrency((autoLaborStats.ba * currentProject.laborPrices[Role.BA]) + (autoLaborStats.tester * currentProject.laborPrices[Role.Tester]))}</td>
                          <td></td>
                        </tr>
                      </>
                    )}
                  </tbody>
                  <tfoot className="bg-slate-900 text-white">
                     <tr>
                        <td colSpan={2} className="px-6 py-4 font-black text-xs uppercase">Tổng chi phí nhân sự</td>
                        <td className="px-6 py-4 text-center font-black text-sm">{((currentProject.labors.reduce((s,l)=>s+l.mandays,0)) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.tester).toFixed(1)} MD</td>
                        <td className="px-6 py-4 text-right font-black text-lg text-indigo-400">{formatCurrency(manualLaborTotal + autoLaborTotal)}</td>
                        <td></td>
                     </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'journal' && (
            <div className="space-y-6 animate-in fade-in duration-500 pb-20">
               <div className="flex justify-between items-center">
                  <h3 className="font-black text-2xl tracking-tight text-slate-800">Nhật ký dự án</h3>
                  <div className="flex gap-2">
                     <button onClick={() => handleAddJournal(JournalEntryType.Meeting)} className="bg-indigo-50 text-indigo-600 border border-indigo-100 px-4 py-2 rounded-xl text-xs font-bold transition-all">+ Họp</button>
                     <button onClick={() => handleAddJournal(JournalEntryType.Milestone)} className="bg-amber-50 text-amber-600 border border-amber-100 px-4 py-2 rounded-xl text-xs font-bold transition-all">+ Mốc</button>
                  </div>
               </div>
               <div className="relative pl-8 border-l-2 border-slate-200 ml-4 space-y-10">
                  {(currentProject.journal || []).map((entry) => (
                    <div key={entry.id} className="relative">
                       <div className={`absolute -left-[41px] top-0 w-5 h-5 rounded-full border-4 border-white shadow-sm ${entry.type === JournalEntryType.Milestone ? 'bg-amber-500 scale-125' : 'bg-indigo-500'}`}></div>
                       <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                          <div className="flex justify-between items-center mb-4">
                             <div className="flex items-center gap-3">
                                <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${entry.type === JournalEntryType.Milestone ? 'bg-amber-100 text-amber-600' : 'bg-indigo-100 text-indigo-600'}`}>{entry.type}</span>
                                <input type="date" className="text-[10px] font-bold text-slate-400 bg-transparent outline-none" value={entry.date} onChange={(e) => updateProject({ journal: currentProject.journal?.map(j => j.id === entry.id ? {...j, date: e.target.value} : j) })} />
                             </div>
                             <button onClick={() => updateProject({ journal: currentProject.journal?.filter(j => j.id !== entry.id) })} className="text-slate-300 hover:text-red-500">×</button>
                          </div>
                          <input className="text-sm font-black text-slate-800 w-full bg-transparent border-none outline-none mb-2" value={entry.title} onChange={(e) => updateProject({ journal: currentProject.journal?.map(j => j.id === entry.id ? {...j, title: e.target.value} : j) })} />
                          <textarea rows={3} className="text-xs text-slate-500 w-full bg-slate-50 p-4 rounded-2xl border-none outline-none resize-none" value={entry.content} onChange={(e) => updateProject({ journal: currentProject.journal?.map(j => j.id === entry.id ? {...j, content: e.target.value} : j) })} />
                       </div>
                    </div>
                  ))}
               </div>
            </div>
          )}

          {activeTab === 'infra' && (
            <div className="space-y-6 animate-in fade-in duration-500">
               <div className="flex justify-between items-center">
                 <h3 className="font-black text-2xl tracking-tight text-slate-800">Hạ tầng Cloud</h3>
                 <button onClick={() => updateProject({ servers: [...currentProject.servers, { id: 's'+Date.now(), category: Category.AppServer, os: 'Linux', configRaw: '4 core 8GB storage: 100GB', quantity: 1, content: 'Server mới', note: '', storageType: 'diskSanAllFlash', bwQt: 0, bwInternal: 0 }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold transition-all shadow-lg">+ Thêm VM</button>
               </div>
               <div className="bg-white rounded-[32px] border border-slate-200 shadow-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                    <tr><th className="px-6 py-4">Mô tả</th><th className="px-6 py-4">Cấu hình</th><th className="px-6 py-4 text-center">SL</th><th className="px-6 py-4 text-right">Giá</th><th className="px-6 py-4 w-16"></th></tr>
                  </thead>
                  <tbody>
                    {currentProject.servers.map(s => {
                      const cost = calculateItemCost(s, currentProject.infraPrices);
                      return (
                        <tr key={s.id} className="border-b border-slate-50 group hover:bg-slate-50/50 transition-all">
                          <td className="px-6 py-4 font-bold text-xs"><input className="bg-transparent w-full outline-none" value={s.content} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, content: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4"><input className="w-full bg-slate-100 p-2 rounded-xl text-xs outline-none" value={s.configRaw} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, configRaw: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4 text-center"><input type="number" className="w-12 text-center bg-slate-100 rounded-lg py-1 text-xs font-bold" value={s.quantity} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, quantity: parseInt(e.target.value) || 1} : item)})} /></td>
                          <td className="px-6 py-4 text-right font-black text-indigo-600 text-sm">{formatCurrency(cost.totalPrice)}</td>
                          <td className="px-6 py-4 text-right"><button onClick={() => updateProject({ servers: currentProject.servers.filter(item => item.id !== s.id)})} className="text-red-400 opacity-0 group-hover:opacity-100 font-bold transition-all hover:scale-125">×</button></td>
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
                 <h3 className="text-2xl font-black mb-8 text-slate-800">Unit Prices</h3>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                   <div className="space-y-6">
                     <p className="text-xs font-black text-indigo-600 uppercase tracking-widest">Cloud Infrastructure</p>
                     <PriceRow label="vCPU / Month" value={currentProject.infraPrices.cpu} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, cpu: v}})} />
                     <PriceRow label="GB RAM / Month" value={currentProject.infraPrices.ram} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, ram: v}})} />
                     <PriceRow label="SSD All Flash (1GB)" value={currentProject.infraPrices.diskSanAllFlash} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, diskSanAllFlash: v}})} />
                   </div>
                   <div className="space-y-6">
                     <p className="text-xs font-black text-emerald-600 uppercase tracking-widest">Labor Rates (Daily)</p>
                     {Object.values(Role).map(r => (
                       <PriceRow key={r} label={r} value={currentProject.laborPrices[r] || 0} onChange={(v) => updateProject({ laborPrices: {...currentProject.laborPrices, [r]: v}})} unit="VNĐ" />
                     ))}
                   </div>
                 </div>
              </div>
            </div>
          )}
        </div>

        <footer className="h-20 bg-[#0F172A] text-white px-8 flex items-center justify-between shrink-0 shadow-2xl relative z-20">
          <div className="flex gap-10">
            <div>
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mb-0.5">Tổng MD</p>
              <p className="text-xl font-black">{((currentProject.labors.reduce((s,l)=>s+l.mandays,0)) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.tester).toFixed(1)}</p>
            </div>
            <div className="hidden md:block border-l border-slate-800 pl-10">
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mb-0.5">Dự kiến</p>
              <p className="text-sm font-bold text-indigo-400">{currentProject.startDate ? new Date(currentProject.startDate).toLocaleDateString() : '??'} → {currentProject.endDate ? new Date(currentProject.endDate).toLocaleDateString() : '??'}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[8px] text-indigo-400 font-bold uppercase mb-0.5 tracking-widest">TỔNG CHI PHÍ DỰ TOÁN (TCO)</p>
            <p className="text-2xl font-black tracking-tight">{formatCurrency(grandTotal)}</p>
          </div>
        </footer>
      </main>
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
      `}} />
    </div>
  );
};

export default App;
