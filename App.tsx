
import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { ServerItem, LaborItem, Category, Role, Project, TaskStatus, Priority } from './types';
import { INITIAL_SERVERS, INITIAL_LABOR_ITEMS, INITIAL_UNIT_PRICES, INITIAL_LABOR_PRICES } from './constants';
import { calculateItemCost, calculateLaborCost, formatCurrency, saveProjectToCloud, fetchProjectsFromCloud, deleteProjectFromCloud, checkSupabaseConnection, generateDeploymentScript, exportProjectToExcel, mapStringToRole, downloadImportTemplate, getCloudConfig, saveCloudConfig, resetSupabaseInstance } from './utils';
import { analyzeArchitecture, predictTaskMandays } from './geminiService';

type Tab = 'overview' | 'mandays' | 'board' | 'infra' | 'settings';

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
  const [isDirty, setIsDirty] = useState(false);
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
          const first: Project = { id: 'p1', name: 'Dự án Mẫu', servers: INITIAL_SERVERS, labors: INITIAL_LABOR_ITEMS, infraPrices: INITIAL_UNIT_PRICES, laborPrices: INITIAL_LABOR_PRICES, createdAt: Date.now(), lastModified: Date.now() };
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
    setIsDirty(true);
  };

  const projectStats = useMemo(() => {
    if (!currentProject) return { progress: 0, todo: 0, doing: 0, done: 0, total: 0 };
    const tasks = currentProject.labors;
    const total = tasks.length;
    if (total === 0) return { progress: 0, todo: 0, doing: 0, done: 0, total: 0 };
    const done = tasks.filter(t => t.status === TaskStatus.Done).length;
    const doing = tasks.filter(t => t.status === TaskStatus.Doing || t.status === TaskStatus.Review).length;
    const todo = tasks.filter(t => t.status === TaskStatus.Todo).length;
    return { progress: Math.round((done / total) * 100), todo, doing, done, total };
  }, [currentProject]);

  const infraTotal = useMemo(() => currentProject ? (currentProject.servers || []).reduce((sum, s) => sum + calculateItemCost(s, currentProject.infraPrices).totalPrice, 0) : 0, [currentProject]);
  const manualLaborTotal = useMemo(() => currentProject ? (currentProject.labors || []).reduce((sum, l) => sum + calculateLaborCost(l, currentProject.laborPrices), 0) : 0, [currentProject]);
  const autoLaborStats = useMemo(() => {
    if (!currentProject) return { pm: 0, ba: 0, tester: 0, devTotal: 0 };
    const devMandays = currentProject.labors.filter(l => l.role === Role.SeniorDev || l.role === Role.JuniorDev).reduce((sum, l) => sum + (l.mandays || 0), 0);
    const ratio = 1 / 3;
    return { devTotal: devMandays, pm: devMandays * ratio, ba: devMandays * ratio, tester: devMandays * ratio };
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
      setIsDirty(false); 
      alert("Đã lưu thành công!"); 
    } catch (e) { alert("Lỗi lưu Cloud."); } finally { setIsSyncing(false); } 
  };

  const handleNewProject = () => {
    const id = 'p' + Date.now();
    const newProj: Project = { 
      id, 
      name: 'Dự án mới', 
      servers: [], 
      labors: [], 
      infraPrices: INITIAL_UNIT_PRICES, 
      laborPrices: INITIAL_LABOR_PRICES, 
      createdAt: Date.now(), 
      lastModified: Date.now() 
    };
    setProjects([newProj, ...projects]);
    setCurrentProjectId(id);
    setIsDirty(true);
  };

  const handleDuplicateProject = () => {
    if (!currentProject) return;
    const id = 'p-copy-' + Date.now();
    const copy: Project = { 
      ...currentProject, 
      id, 
      name: `${currentProject.name} (Bản sao)`, 
      createdAt: Date.now(), 
      lastModified: Date.now() 
    };
    setProjects([copy, ...projects]);
    setCurrentProjectId(id);
    setIsDirty(true);
    alert("Đã nhân bản dự án!");
  };

  const handleDeleteProject = async (id: string) => {
    if (!window.confirm("Bạn có chắc chắn muốn xóa dự án này?")) return;
    await deleteProjectFromCloud(id);
    const updated = projects.filter(p => p.id !== id);
    setProjects(updated);
    if (currentProjectId === id) {
      setCurrentProjectId(updated.length > 0 ? updated[0].id : null);
    }
  };

  const handleImportExcel = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const wsname = wb.SheetNames[0];
      const ws = wb.Sheets[wsname];
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

  if (isLoading || !currentProject) return <div className="min-h-screen bg-[#0F172A] flex flex-col items-center justify-center text-white font-black tracking-widest">
    <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
    ĐANG TẢI DỮ LIỆU...
  </div>;

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
                     {projects.length > 1 && (
                       <button onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }} className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                       </button>
                     )}
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
                         <h4 className="font-black text-lg">Phân bổ Ngân sách</h4>
                         <div className="flex gap-4">
                            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-indigo-500"></div><span className="text-[10px] font-bold text-slate-500">Hạ tầng</span></div>
                            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-amber-500"></div><span className="text-[10px] font-bold text-slate-500">Nhân sự</span></div>
                         </div>
                      </div>
                      
                      <div className="w-full h-8 bg-slate-100 rounded-2xl overflow-hidden flex mb-8">
                         <div className="bg-indigo-500 h-full transition-all duration-700" style={{ width: `${(infraTotal / (grandTotal || 1)) * 100}%` }}></div>
                         <div className="bg-amber-500 h-full transition-all duration-700" style={{ width: `${((manualLaborTotal + autoLaborTotal) / (grandTotal || 1)) * 100}%` }}></div>
                      </div>

                      <div className="grid grid-cols-2 gap-8">
                         <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Chi phí Hạ tầng</p>
                            <p className="text-xl font-black text-slate-800">{formatCurrency(infraTotal)}</p>
                            <p className="text-[10px] text-slate-500 mt-1 italic">Vận hành máy chủ, storage, network...</p>
                         </div>
                         <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Chi phí Nhân sự</p>
                            <p className="text-xl font-black text-slate-800">{formatCurrency(manualLaborTotal + autoLaborTotal)}</p>
                            <p className="text-[10px] text-slate-500 mt-1 italic">BA, PM, Dev, Tester, Designer...</p>
                         </div>
                      </div>
                   </div>

                   <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-xl relative overflow-hidden">
                      <h4 className="font-black text-lg mb-4">Các Task Ưu tiên cao</h4>
                      <div className="space-y-4">
                        {currentProject.labors.filter(l => l.priority === Priority.Urgent || l.priority === Priority.High).slice(0, 4).map(task => (
                          <div key={task.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:shadow-sm transition-all">
                             <div className="flex items-center gap-4">
                                <PriorityBadge priority={task.priority} />
                                <div>
                                   <p className="text-xs font-bold text-slate-800">{task.taskName}</p>
                                   <p className="text-[10px] text-slate-400 line-clamp-1">{task.description || 'Không có mô tả chi tiết'}</p>
                                </div>
                             </div>
                             <div className="text-right">
                                <StatusBadge status={task.status} />
                                <p className="text-[9px] font-black text-slate-300 mt-1 uppercase">{task.assignee || 'Chưa phân'}</p>
                             </div>
                          </div>
                        ))}
                        {currentProject.labors.filter(l => l.priority === Priority.Urgent || l.priority === Priority.High).length === 0 && <p className="text-center text-xs text-slate-400 py-6 italic">Không có task khẩn cấp.</p>}
                      </div>
                   </div>
                </div>

                <div className="space-y-6">
                   <div className="bg-indigo-600 p-8 rounded-[40px] text-white shadow-2xl relative overflow-hidden">
                      <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-500 rounded-full blur-2xl opacity-50"></div>
                      <h4 className="font-black text-lg mb-2 relative z-10">AI Project Advisor</h4>
                      <p className="text-xs text-indigo-100 mb-6 leading-relaxed relative z-10">Tôi sẽ phân tích cấu hình hạ tầng và dự toán nhân lực để tìm điểm bất hợp lý.</p>
                      <button onClick={async () => { setIsAnalyzing(true); setAnalysis(await analyzeArchitecture(currentProject.servers, currentProject.labors)); setIsAnalyzing(false); }} className="w-full bg-white text-indigo-600 py-3 rounded-2xl text-xs font-black transition-all hover:bg-indigo-50 shadow-xl">
                        {isAnalyzing ? "Đang xử lý..." : "Phân tích dự án"}
                      </button>
                   </div>
                   {analysis && (
                     <div className="bg-amber-50 border border-amber-200 p-6 rounded-[32px] text-amber-900 text-[11px] leading-relaxed whitespace-pre-line animate-in zoom-in duration-300 shadow-inner">
                        <div className="flex items-center gap-2 mb-2">
                           <svg className="w-4 h-4 text-amber-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>
                           <span className="font-black uppercase tracking-widest text-[10px]">Đánh giá từ AI:</span>
                        </div>
                        {analysis}
                     </div>
                   )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'mandays' && (
            <div className="space-y-6 animate-in fade-in duration-500">
              <div className="flex justify-between items-center">
                <div>
                   <h3 className="font-black text-2xl tracking-tight text-slate-800">Kế hoạch & Dự toán Chi tiết</h3>
                   <div className="flex items-center gap-2 mt-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Đang cập nhật trực tiếp</p>
                   </div>
                </div>
                <div className="flex gap-2">
                  <input type="file" ref={fileInputRef} onChange={handleImportExcel} className="hidden" accept=".xlsx,.xls" />
                  <button onClick={downloadImportTemplate} className="bg-white text-slate-600 border border-slate-200 px-4 py-2 rounded-xl text-xs font-bold hover:bg-slate-50 flex items-center gap-2 transition-all">
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg>
                     Mẫu nhập
                  </button>
                  <button onClick={() => fileInputRef.current?.click()} className="bg-white text-indigo-600 border border-indigo-100 px-4 py-2 rounded-xl text-xs font-bold hover:bg-indigo-50 flex items-center gap-2 transition-all shadow-sm">
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                     Nhập Excel
                  </button>
                  <button onClick={handleEstimateAll} disabled={isEstimatingAll} className="bg-amber-100 text-amber-700 px-4 py-2 rounded-xl text-xs font-bold hover:bg-amber-200 shadow-sm transition-all">
                    {isEstimatingAll ? "AI Đang tính..." : "AI Ước lượng"}
                  </button>
                  <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Công việc mới', role: Role.JuniorDev, mandays: 1, description: '', status: TaskStatus.Todo, priority: Priority.Medium, assignee: '', dueDate: '' }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold shadow-lg shadow-indigo-200 hover:bg-indigo-500 transition-all">+ Thêm Task</button>
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
                           <input className="w-full bg-transparent font-bold text-xs outline-none mb-1 border-b border-transparent focus:border-indigo-200" value={l.taskName} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, taskName: e.target.value} : item)})} />
                           <select className="text-[10px] bg-slate-100 px-2 py-0.5 rounded border-none font-bold text-slate-500 cursor-pointer" value={l.role} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, role: e.target.value as Role} : item)})}>
                             {Object.values(Role).map(r => <option key={r} value={r}>{r}</option>)}
                           </select>
                        </td>
                        <td className="px-6 py-4">
                           <textarea rows={1} className="w-full bg-transparent text-[11px] outline-none text-slate-500 resize-none border-b border-transparent focus:border-indigo-200" placeholder="Mô tả công việc..." value={l.description} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, description: e.target.value} : item)})} />
                        </td>
                        <td className="px-6 py-4 text-center">
                          <input type="number" step="0.5" className="w-16 text-center bg-slate-100 rounded-lg py-1 text-xs font-bold outline-none border border-transparent focus:border-indigo-300" value={l.mandays} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, mandays: parseFloat(e.target.value) || 0} : item)})} />
                        </td>
                        <td className="px-6 py-4 text-right font-black text-slate-700 text-xs">{formatCurrency(calculateLaborCost(l, currentProject.laborPrices))}</td>
                        <td className="px-6 py-4 text-right"><button onClick={() => updateProject({ labors: currentProject.labors.filter(item => item.id !== l.id)})} className="text-red-400 opacity-0 group-hover:opacity-100 font-bold transition-all hover:scale-125">×</button></td>
                      </tr>
                    ))}
                    {currentProject.labors.length === 0 && <tr><td colSpan={5} className="px-6 py-20 text-center text-xs text-slate-400 italic">Danh sách trống. Hãy thêm task mới hoặc nhập từ Excel để bắt đầu dự toán.</td></tr>}
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
                       <h4 className="font-black text-xs uppercase tracking-widest text-slate-500 flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${status === TaskStatus.Todo ? 'bg-slate-300' : status === TaskStatus.Doing ? 'bg-indigo-500' : status === TaskStatus.Review ? 'bg-amber-400' : 'bg-emerald-500'}`}></div>
                          {status}
                       </h4>
                       <span className="bg-slate-200 text-slate-600 text-[10px] px-2 py-0.5 rounded-full font-black">{currentProject.labors.filter(t => t.status === status).length}</span>
                    </div>
                    <div className="flex-1 space-y-4 min-h-[500px] bg-slate-200/30 p-4 rounded-3xl border border-slate-200/50">
                       {currentProject.labors.filter(t => t.status === status).map(task => (
                         <div key={task.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 group hover:shadow-md transition-all">
                            <div className="flex justify-between items-start mb-3">
                               <PriorityBadge priority={task.priority} />
                               <select className="opacity-0 group-hover:opacity-100 text-[9px] font-bold bg-slate-100 rounded px-1 transition-all outline-none cursor-pointer" value={task.status} onChange={(e) => updateProject({ labors: currentProject.labors.map(t => t.id === task.id ? {...t, status: e.target.value as TaskStatus} : t)})}>
                                  {Object.values(TaskStatus).map(s => <option key={s} value={s}>{s}</option>)}
                               </select>
                            </div>
                            <h5 className="font-bold text-xs text-slate-800 mb-2 leading-snug">{task.taskName}</h5>
                            <p className="text-[10px] text-slate-400 line-clamp-2 mb-4 h-8">{task.description || 'Không có mô tả chi tiết'}</p>
                            <div className="flex items-center justify-between mt-4">
                               <div className="flex items-center gap-2">
                                  <div className="w-6 h-6 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-600">
                                    {task.assignee ? task.assignee.charAt(0) : '?'}
                                  </div>
                                  <input className="text-[10px] text-slate-400 bg-transparent border-none outline-none w-24 focus:text-indigo-600" placeholder="Gán việc..." value={task.assignee} onChange={(e) => updateProject({ labors: currentProject.labors.map(t => t.id === task.id ? {...t, assignee: e.target.value} : t)})} />
                               </div>
                               <span className="text-[10px] font-black text-slate-300">{task.mandays} MD</span>
                            </div>
                         </div>
                       ))}
                       <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Task mới', role: Role.JuniorDev, mandays: 1, description: '', status: status, priority: Priority.Medium, assignee: '', dueDate: '' }] })} className="w-full py-3 border-2 border-dashed border-slate-200 rounded-2xl text-[10px] font-black text-slate-400 hover:border-indigo-300 hover:text-indigo-400 transition-all transition-colors">+ Task mới</button>
                    </div>
                 </div>
               ))}
            </div>
          )}

          {activeTab === 'infra' && (
            <div className="space-y-6 animate-in fade-in duration-500">
               <div className="flex justify-between items-center">
                 <h3 className="font-black text-2xl tracking-tight text-slate-800">Tài nguyên Hạ tầng Cloud</h3>
                 <button onClick={() => updateProject({ servers: [...currentProject.servers, { id: 's'+Date.now(), category: Category.AppServer, os: 'Linux', configRaw: '4 core 8GB storage: 100GB', quantity: 1, content: 'Server mới', note: '', storageType: 'diskSanAllFlash', bwQt: 0, bwInternal: 0 }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold transition-all shadow-lg hover:bg-indigo-500">+ Thêm VM</button>
               </div>
               <div className="bg-white rounded-[32px] border border-slate-200 shadow-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                    <tr><th className="px-6 py-4">Mô tả dịch vụ</th><th className="px-6 py-4">Cấu hình chi tiết (vCPU, RAM, Disk)</th><th className="px-6 py-4 text-center">Số lượng</th><th className="px-6 py-4 text-right">Giá / Tháng</th><th className="px-6 py-4 w-16"></th></tr>
                  </thead>
                  <tbody>
                    {currentProject.servers.map(s => {
                      const cost = calculateItemCost(s, currentProject.infraPrices);
                      return (
                        <tr key={s.id} className="border-b border-slate-50 group hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4 font-bold text-xs"><input className="bg-transparent w-full outline-none focus:border-b focus:border-indigo-300" value={s.content} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, content: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4"><input className="w-full bg-slate-100 p-2 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-300" value={s.configRaw} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, configRaw: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4 text-center"><input type="number" className="w-12 text-center bg-slate-100 rounded-lg py-1 text-xs font-bold border border-transparent focus:border-indigo-300 outline-none" value={s.quantity} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, quantity: parseInt(e.target.value) || 1} : item)})} /></td>
                          <td className="px-6 py-4 text-right font-black text-indigo-600 text-sm">{formatCurrency(cost.totalPrice)}</td>
                          <td className="px-6 py-4 text-right"><button onClick={() => updateProject({ servers: currentProject.servers.filter(item => item.id !== s.id)})} className="text-red-400 opacity-0 group-hover:opacity-100 font-bold transition-all hover:scale-125">×</button></td>
                        </tr>
                      );
                    })}
                    {currentProject.servers.length === 0 && <tr><td colSpan={5} className="px-6 py-20 text-center text-xs text-slate-400 italic">Dữ liệu hạ tầng đang trống.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-8 animate-in fade-in duration-500 pb-20">
               <div className="bg-white p-10 rounded-[40px] border border-slate-200 shadow-xl">
                 <h3 className="text-2xl font-black mb-8 text-slate-800">Tham số Dự toán (Unit Price)</h3>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                   <div className="space-y-6">
                     <div className="flex items-center gap-3 mb-4">
                        <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-500">
                           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                        </div>
                        <p className="text-xs font-black text-indigo-600 uppercase tracking-widest">Hạ tầng Cloud</p>
                     </div>
                     <PriceRow label="Đơn giá 1 vCPU / Tháng" value={currentProject.infraPrices.cpu} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, cpu: v}})} />
                     <PriceRow label="Đơn giá 1 GB RAM / Tháng" value={currentProject.infraPrices.ram} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, ram: v}})} />
                     <PriceRow label="SSD All Flash (1GB/Tháng)" value={currentProject.infraPrices.diskSanAllFlash} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, diskSanAllFlash: v}})} />
                     <PriceRow label="Object Storage (1GB/Tháng)" value={currentProject.infraPrices.storageMinio} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, storageMinio: v}})} />
                   </div>
                   <div className="space-y-6">
                     <div className="flex items-center gap-3 mb-4">
                        <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-500">
                           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                        </div>
                        <p className="text-xs font-black text-emerald-600 uppercase tracking-widest">Nhân sự (Rate/Manday)</p>
                     </div>
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
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mb-0.5">Tổng khối lượng</p>
              <p className="text-xl font-black">{((currentProject.labors.reduce((s,l)=>s+l.mandays,0)) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.tester).toFixed(1)} MD</p>
            </div>
            <div className="hidden md:block border-l border-slate-800 pl-10">
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mb-0.5">Thời gian thực hiện</p>
              <p className="text-sm font-bold text-indigo-400">{currentProject.startDate ? new Date(currentProject.startDate).toLocaleDateString('vi-VN') : '??'} → {currentProject.endDate ? new Date(currentProject.endDate).toLocaleDateString('vi-VN') : '??'}</p>
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
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #475569; }
        input[type="date"]::-webkit-calendar-picker-indicator {
          filter: invert(0.5);
          cursor: pointer;
        }
      `}} />
    </div>
  );
};

export default App;
