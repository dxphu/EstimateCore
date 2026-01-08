
import React, { useState, useEffect, useMemo, useRef } from 'react';
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
    className={`flex flex-col md:flex-row items-center gap-1 md:gap-3 px-4 py-3 rounded-xl transition-all font-bold text-[10px] md:text-sm flex-1 md:flex-none ${activeTab === id ? 'text-indigo-600 md:bg-indigo-600 md:text-white' : 'text-slate-400 md:text-slate-300 hover:bg-slate-800'}`}
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
  const [dbStatus, setDbStatus] = useState<{ status: 'idle' | 'loading' | 'success' | 'error', message: string }>({ status: 'idle', message: '' });
  const [showScriptModal, setShowScriptModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cloudConfig, setCloudConfig] = useState(getCloudConfig());

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
  const handleSaveProject = async () => { if (!currentProject) return; setIsSyncing(true); try { await saveProjectToCloud(currentProject); setIsDirty(false); alert("Đã lưu thành công!"); } catch (e) { alert("Lỗi lưu Cloud."); } finally { setIsSyncing(false); } };

  // AI-powered estimation for all labor items in the current project to fix the 'Cannot find name' error.
  const handleEstimateAll = async () => {
    if (!currentProject) return;
    setIsEstimatingAll(true);
    try {
      const updatedLabors = await Promise.all(
        currentProject.labors.map(async (l) => {
          // If mandays is still at default (1) or unassigned, trigger AI estimation.
          if (l.mandays > 1) return l;
          const estimated = await predictTaskMandays(l.taskName, l.description, l.role);
          return estimated !== null ? { ...l, mandays: estimated } : l;
        })
      );
      updateProject({ labors: updatedLabors });
    } catch (error) {
      console.error("AI Estimation Error:", error);
    } finally {
      setIsEstimatingAll(false);
    }
  };

  if (isLoading || !currentProject) return <div className="min-h-screen bg-[#0F172A] flex items-center justify-center text-white font-black tracking-widest">ĐANG TẢI...</div>;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col md:flex-row overflow-hidden font-sans">
      <aside className={`fixed inset-y-0 left-0 w-72 bg-[#0F172A] text-white z-[70] transition-transform md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} flex flex-col h-screen shadow-2xl`}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-8">
            <span className="font-black text-2xl tracking-tighter bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">EstimaCore</span>
          </div>
          <nav className="space-y-1">
            <NavItem id="overview" label="Tổng quan" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16m-7 6h7" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="mandays" label="Kế hoạch & Dự toán" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="board" label="Thực thi (Board)" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="infra" label="Hạ tầng Cloud" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
            <NavItem id="settings" label="Thiết lập" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2" strokeWidth="2" /></svg>} activeTab={activeTab} onClick={handleNavItemClick} />
          </nav>
        </div>
        <div className="mt-auto p-6 bg-slate-900/50">
          <p className="text-[10px] uppercase text-slate-500 font-bold mb-3">Dự án hiện tại</p>
          <div className="mb-4">
             <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] font-bold text-slate-400">Tiến độ thực thi</span>
                <span className="text-[10px] font-bold text-indigo-400">{projectStats.progress}%</span>
             </div>
             <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                <div className="bg-indigo-500 h-full transition-all duration-500" style={{ width: `${projectStats.progress}%` }}></div>
             </div>
          </div>
          <button onClick={() => { const id = 'p'+Date.now(); setProjects([{ id, name: 'Dự án mới', servers: [], labors: [], infraPrices: INITIAL_UNIT_PRICES, laborPrices: INITIAL_LABOR_PRICES, createdAt: Date.now(), lastModified: Date.now() }, ...projects]); setCurrentProjectId(id); setIsDirty(true); }} className="w-full py-2 bg-indigo-600 rounded-lg text-xs font-bold transition-all hover:bg-indigo-50 shadow-lg shadow-indigo-900/40">Tạo dự án mới</button>
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
             <button onClick={handleSaveProject} disabled={isSyncing} className={`px-5 py-2.5 rounded-xl text-xs font-black transition-all ${isDirty ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400'}`}>
                {isSyncing ? "Đang lưu..." : "Đồng bộ Cloud"}
             </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 bg-slate-50/50">
          {activeTab === 'overview' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                 <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                    <span className="text-slate-400 font-bold text-[10px] uppercase">Tổng ngân sách</span>
                    <p className="text-2xl font-black text-indigo-600 mt-1">{formatCurrency(grandTotal)}</p>
                 </div>
                 <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                    <span className="text-slate-400 font-bold text-[10px] uppercase">Tiến độ hoàn thành</span>
                    <p className="text-2xl font-black text-emerald-600 mt-1">{projectStats.progress}%</p>
                 </div>
                 <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                    <span className="text-slate-400 font-bold text-[10px] uppercase">Công việc đang làm</span>
                    <p className="text-2xl font-black text-amber-600 mt-1">{projectStats.doing} Task</p>
                 </div>
                 <div className="bg-white p-6 rounded-[32px] border border-slate-200 shadow-sm">
                    <span className="text-slate-400 font-bold text-[10px] uppercase">Cấu hình hạ tầng</span>
                    <p className="text-2xl font-black text-slate-800 mt-1">{currentProject.servers.length} VM</p>
                 </div>
              </div>
              
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-6">
                   <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-xl overflow-hidden relative">
                      <div className="absolute top-0 right-0 p-8">
                         <div className="w-16 h-16 rounded-full border-4 border-indigo-50 flex items-center justify-center">
                            <span className="text-indigo-600 font-black text-sm">{projectStats.progress}%</span>
                         </div>
                      </div>
                      <h4 className="font-black text-lg mb-4">Hoạt động dự án</h4>
                      <div className="space-y-4">
                        {currentProject.labors.slice(0, 5).map(task => (
                          <div key={task.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                             <div className="flex items-center gap-4">
                                <div className={`w-3 h-3 rounded-full ${task.status === TaskStatus.Done ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`}></div>
                                <div>
                                   <p className="text-xs font-bold text-slate-800">{task.taskName}</p>
                                   <p className="text-[10px] text-slate-400">{task.assignee || 'Chưa phân công'}</p>
                                </div>
                             </div>
                             <StatusBadge status={task.status} />
                          </div>
                        ))}
                      </div>
                   </div>
                </div>
                <div className="space-y-6">
                   <div className="bg-indigo-600 p-8 rounded-[40px] text-white shadow-2xl shadow-indigo-200">
                      <h4 className="font-black text-lg mb-2">AI Advisor</h4>
                      <p className="text-xs text-indigo-100 mb-6 leading-relaxed">Sử dụng AI để phân tích tính khả thi và rủi ro của dự án.</p>
                      <button onClick={async () => { setIsAnalyzing(true); setAnalysis(await analyzeArchitecture(currentProject.servers, currentProject.labors)); setIsAnalyzing(false); }} className="w-full bg-white text-indigo-600 py-3 rounded-2xl text-xs font-black transition-all hover:bg-indigo-50">
                        {isAnalyzing ? "Đang phân tích..." : "Phân tích dự án ngay"}
                      </button>
                   </div>
                   {analysis && (
                     <div className="bg-amber-50 border border-amber-200 p-6 rounded-[32px] text-amber-900 text-xs leading-relaxed whitespace-pre-line">
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
                <h3 className="font-black text-2xl tracking-tight">Kế hoạch & Dự toán Chi phí</h3>
                <div className="flex gap-2">
                  <button onClick={handleEstimateAll} disabled={isEstimatingAll} className="bg-indigo-50 text-indigo-600 px-4 py-2 rounded-xl text-xs font-bold hover:bg-indigo-100 transition-all">
                    {isEstimatingAll ? "AI Đang tính..." : "AI Tự động ước lượng"}
                  </button>
                  <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Task mới', role: Role.JuniorDev, mandays: 1, description: '', status: TaskStatus.Todo, priority: Priority.Medium, assignee: '', dueDate: '' }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold">+ Thêm công việc</button>
                </div>
              </div>
              <div className="bg-white rounded-[32px] border border-slate-200 shadow-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                    <tr>
                      <th className="px-6 py-4">Đầu việc / Vai trò</th>
                      <th className="px-6 py-4 text-center">Độ ưu tiên</th>
                      <th className="px-6 py-4 text-center">Số công (MD)</th>
                      <th className="px-6 py-4 text-right">Chi phí ước tính</th>
                      <th className="px-6 py-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentProject.labors.map(l => (
                      <tr key={l.id} className="border-b border-slate-50 group hover:bg-slate-50/50">
                        <td className="px-6 py-4">
                           <input className="w-full bg-transparent font-bold text-xs outline-none mb-1" value={l.taskName} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, taskName: e.target.value} : item)})} />
                           <div className="flex items-center gap-2">
                             <select className="text-[10px] bg-slate-100 px-2 py-0.5 rounded border-none font-bold text-slate-500" value={l.role} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, role: e.target.value as Role} : item)})}>
                               {Object.values(Role).map(r => <option key={r} value={r}>{r}</option>)}
                             </select>
                           </div>
                        </td>
                        <td className="px-6 py-4 text-center">
                           <select className="text-[10px] bg-transparent border-none font-black outline-none cursor-pointer" value={l.priority} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, priority: e.target.value as Priority} : item)})}>
                             {Object.values(Priority).map(p => <option key={p} value={p}>{p}</option>)}
                           </select>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <input type="number" step="0.5" className="w-12 text-center bg-slate-100 rounded-lg py-1 text-xs font-bold" value={l.mandays} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, mandays: parseFloat(e.target.value) || 0} : item)})} />
                        </td>
                        <td className="px-6 py-4 text-right font-black text-slate-700">{formatCurrency(calculateLaborCost(l, currentProject.laborPrices))}</td>
                        <td className="px-6 py-4 text-right"><button onClick={() => updateProject({ labors: currentProject.labors.filter(item => item.id !== l.id)})} className="text-red-400 opacity-0 group-hover:opacity-100 font-bold transition-all">×</button></td>
                      </tr>
                    ))}
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
                    <div className="flex-1 space-y-4 min-h-[500px] bg-slate-100/40 p-4 rounded-3xl border border-slate-200/50">
                       {currentProject.labors.filter(t => t.status === status).map(task => (
                         <div key={task.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 group hover:shadow-md transition-all cursor-pointer">
                            <div className="flex justify-between items-start mb-3">
                               <PriorityBadge priority={task.priority} />
                               <select className="opacity-0 group-hover:opacity-100 text-[9px] font-bold bg-slate-100 rounded px-1 transition-all" value={task.status} onChange={(e) => updateProject({ labors: currentProject.labors.map(t => t.id === task.id ? {...t, status: e.target.value as TaskStatus} : t)})}>
                                  {Object.values(TaskStatus).map(s => <option key={s} value={s}>{s}</option>)}
                               </select>
                            </div>
                            <h5 className="font-bold text-xs text-slate-800 mb-2">{task.taskName}</h5>
                            <div className="flex items-center justify-between mt-4">
                               <div className="flex items-center gap-2">
                                  <div className="w-6 h-6 rounded-full bg-indigo-50 flex items-center justify-center text-[10px] font-bold text-indigo-600">
                                    {task.assignee ? task.assignee.charAt(0) : '?'}
                                  </div>
                                  <input className="text-[10px] text-slate-400 bg-transparent border-none outline-none w-24" placeholder="Ai làm?" value={task.assignee} onChange={(e) => updateProject({ labors: currentProject.labors.map(t => t.id === task.id ? {...t, assignee: e.target.value} : t)})} />
                               </div>
                               <span className="text-[10px] font-black text-slate-300">{task.mandays} MD</span>
                            </div>
                         </div>
                       ))}
                       <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Task mới', role: Role.JuniorDev, mandays: 1, description: '', status: status, priority: Priority.Medium, assignee: '', dueDate: '' }] })} className="w-full py-3 border-2 border-dashed border-slate-200 rounded-2xl text-[10px] font-black text-slate-400 hover:border-indigo-300 hover:text-indigo-400 transition-all">+ Thêm việc mới</button>
                    </div>
                 </div>
               ))}
            </div>
          )}

          {activeTab === 'infra' && (
            <div className="space-y-6 animate-in fade-in duration-500">
               <div className="flex justify-between items-center">
                 <h3 className="font-black text-2xl tracking-tight">Cấu hình Hạ tầng Cloud</h3>
                 <button onClick={() => updateProject({ servers: [...currentProject.servers, { id: 's'+Date.now(), category: Category.AppServer, os: 'Linux', configRaw: '4 core 8GB storage: 100GB', quantity: 1, content: 'Server mới', note: '', storageType: 'diskSanAllFlash', bwQt: 0, bwInternal: 0 }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold transition-all shadow-lg hover:bg-indigo-500">+ Thêm Server</button>
               </div>
               <div className="bg-white rounded-[32px] border border-slate-200 shadow-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                    <tr><th className="px-6 py-4">Tên dịch vụ</th><th className="px-6 py-4">Cấu hình</th><th className="px-6 py-4 text-center">Số lượng</th><th className="px-6 py-4 text-right">Chi phí / Tháng</th><th className="px-6 py-4"></th></tr>
                  </thead>
                  <tbody>
                    {currentProject.servers.map(s => {
                      const cost = calculateItemCost(s, currentProject.infraPrices);
                      return (
                        <tr key={s.id} className="border-b border-slate-50 group hover:bg-slate-50/50">
                          <td className="px-6 py-4 font-bold text-xs"><input className="bg-transparent w-full outline-none" value={s.content} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, content: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4"><input className="w-full bg-slate-100 p-2 rounded-xl text-xs outline-none" value={s.configRaw} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, configRaw: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4 text-center"><input type="number" className="w-12 text-center bg-slate-100 rounded-lg py-1 text-xs font-bold" value={s.quantity} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, quantity: parseInt(e.target.value) || 1} : item)})} /></td>
                          <td className="px-6 py-4 text-right font-black text-indigo-600 text-sm">{formatCurrency(cost.totalPrice)}</td>
                          <td className="px-6 py-4 text-right"><button onClick={() => updateProject({ servers: currentProject.servers.filter(item => item.id !== s.id)})} className="text-red-400 opacity-0 group-hover:opacity-100 font-bold">×</button></td>
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
                 <h3 className="text-2xl font-black mb-8">Cài đặt Dự toán</h3>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                   <div className="space-y-6">
                     <p className="text-xs font-black text-indigo-600 uppercase border-b pb-2 tracking-widest">Hạ tầng Cloud</p>
                     <PriceRow label="1 vCPU" value={currentProject.infraPrices.cpu} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, cpu: v}})} />
                     <PriceRow label="1 GB RAM" value={currentProject.infraPrices.ram} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, ram: v}})} />
                     <PriceRow label="SSD All Flash (GB)" value={currentProject.infraPrices.diskSanAllFlash} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, diskSanAllFlash: v}})} />
                     <PriceRow label="MinIO (GB)" value={currentProject.infraPrices.storageMinio} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, storageMinio: v}})} />
                   </div>
                   <div className="space-y-6">
                     <p className="text-xs font-black text-emerald-600 uppercase border-b pb-2 tracking-widest">Nhân sự (Manday)</p>
                     {Object.values(Role).map(r => (
                       <PriceRow key={r} label={r} value={currentProject.laborPrices[r] || 0} onChange={(v) => updateProject({ laborPrices: {...currentProject.laborPrices, [r]: v}})} unit="VNĐ/NGÀY" />
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
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Tổng lực lượng</p>
              <p className="text-xl font-black">{((currentProject.labors.reduce((s,l)=>s+l.mandays,0)) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.tester).toFixed(1)} MD</p>
            </div>
            <div className="hidden md:block">
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Hoàn thành</p>
              <p className="text-xl font-black">{projectStats.progress}%</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[8px] text-indigo-400 font-bold uppercase tracking-widest">DỰ TOÁN HÀNG THÁNG</p>
            <p className="text-2xl font-black">{formatCurrency(grandTotal)}</p>
          </div>
        </footer>
      </main>
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; }
      `}} />
    </div>
  );
};

export default App;
