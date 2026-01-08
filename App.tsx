
import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { ServerItem, LaborItem, Category, Role, Project } from './types';
import { INITIAL_SERVERS, INITIAL_LABOR_ITEMS, INITIAL_UNIT_PRICES, INITIAL_LABOR_PRICES } from './constants';
import { calculateItemCost, calculateLaborCost, formatCurrency, saveProjectToCloud, fetchProjectsFromCloud, deleteProjectFromCloud, checkSupabaseConnection, generateDeploymentScript, exportProjectToExcel, mapStringToRole, downloadImportTemplate, getCloudConfig, saveCloudConfig, resetSupabaseInstance } from './utils';
import { analyzeArchitecture, predictTaskMandays } from './geminiService';

type Tab = 'overview' | 'mandays' | 'infra' | 'settings';

const PriceRow: React.FC<{ label: string, value: number, onChange: (val: number) => void, unit?: string }> = ({ label, value, onChange, unit = "VNĐ" }) => (
  <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
    <span className="text-[11px] font-semibold text-slate-500 pr-2">{label}</span>
    <div className="flex items-center gap-2 flex-shrink-0">
      <input 
        type="number" 
        className="w-24 md:w-32 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-black text-right focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all" 
        value={value || 0} 
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)} 
      />
      <span className="text-[9px] text-slate-400 font-bold w-10 uppercase">{unit}</span>
    </div>
  </div>
);

interface NavItemProps {
  id: Tab;
  label: string;
  icon: React.ReactNode;
  activeTab: Tab;
  onClick: (id: Tab) => void;
}

const NavItem: React.FC<NavItemProps> = ({ id, label, icon, activeTab, onClick }) => (
  <button
    onClick={() => onClick(id)}
    className={`flex flex-col md:flex-row items-center gap-1 md:gap-3 px-2 md:px-4 py-2 md:py-3 rounded-xl transition-all font-bold text-[10px] md:text-sm flex-1 md:flex-none ${activeTab === id ? 'text-indigo-600 md:bg-indigo-600 md:text-white' : 'text-slate-400 md:text-slate-300 hover:bg-slate-800'}`}
  >
    <span>{icon}</span>
    <span>{label}</span>
  </button>
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

  // Cấu hình Cloud mới
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
          const first: Project = {
            id: 'p1',
            name: 'Dự án Mẫu',
            servers: INITIAL_SERVERS,
            labors: INITIAL_LABOR_ITEMS,
            infraPrices: INITIAL_UNIT_PRICES,
            laborPrices: INITIAL_LABOR_PRICES,
            createdAt: Date.now(),
            lastModified: Date.now()
          };
          setProjects([first]);
          setCurrentProjectId('p1');
          await saveProjectToCloud(first);
        }
      } catch (error) {
        console.error("Failed to initialize projects:", error);
      } finally {
        setIsLoading(false);
      }
    };
    init();
  }, []);

  const currentProject = useMemo(() => 
    projects.find(p => p.id === currentProjectId) || null,
    [projects, currentProjectId]
  );

  const updateProject = (updates: Partial<Project>) => {
    if (!currentProjectId || !currentProject) return;
    const updated = { ...currentProject, ...updates, lastModified: Date.now() };
    setProjects(prev => prev.map(p => p.id === currentProjectId ? updated : p));
    setIsDirty(true);
  };

  const handleSaveProject = async () => {
    if (!currentProject) return;
    setIsSyncing(true);
    try {
      await saveProjectToCloud(currentProject);
      setIsDirty(false);
      alert("Đã lưu dự án thành công!");
    } catch (e) {
      alert("Lỗi khi lưu dữ liệu lên Cloud. Hãy kiểm tra lại kết nối Supabase.");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveCloudConfig = () => {
    saveCloudConfig(cloudConfig);
    resetSupabaseInstance();
    alert("Đã lưu cấu hình Cloud thành công!");
    handleCheckDb(); // Tự động kiểm tra lại kết nối
  };

  const handleCheckDb = async () => {
    setDbStatus({ status: 'loading', message: 'Đang kiểm tra kết nối...' });
    try {
      const result = await checkSupabaseConnection();
      setDbStatus({ 
        status: result.success ? 'success' : 'error', 
        message: String(result.message || 'Lỗi không xác định') 
      });
    } catch (err: any) {
      setDbStatus({ status: 'error', message: String(err.message || 'Lỗi hệ thống') });
    }
  };

  const autoLaborStats = useMemo(() => {
    if (!currentProject) return { pm: 0, ba: 0, tester: 0, devTotal: 0 };
    const devMandays = (currentProject.labors || [])
      .filter(l => l.role === Role.SeniorDev || l.role === Role.JuniorDev)
      .reduce((sum, l) => sum + (l.mandays || 0), 0);
    const ratio = 1 / 3;
    return {
      devTotal: devMandays,
      pm: devMandays * ratio,
      ba: devMandays * ratio,
      tester: devMandays * ratio
    };
  }, [currentProject]);

  const infraTotal = useMemo(() => {
    if (!currentProject) return 0;
    return (currentProject.servers || []).reduce((sum, s) => sum + calculateItemCost(s, currentProject.infraPrices).totalPrice, 0);
  }, [currentProject]);

  const manualLaborTotal = useMemo(() => {
    if (!currentProject) return 0;
    return (currentProject.labors || []).reduce((sum, l) => sum + calculateLaborCost(l, currentProject.laborPrices), 0);
  }, [currentProject]);

  const autoLaborTotal = useMemo(() => {
    if (!currentProject) return 0;
    const lp = currentProject.laborPrices;
    return (autoLaborStats.pm * (lp[Role.PM] || 0)) + (autoLaborStats.ba * (lp[Role.BA] || 0)) + (autoLaborStats.tester * (lp[Role.Tester] || 0));
  }, [currentProject, autoLaborStats]);

  const grandTotal = infraTotal + manualLaborTotal + autoLaborTotal;

  const deploymentScript = useMemo(() => {
    if (!currentProject) return "";
    return generateDeploymentScript(currentProject);
  }, [currentProject]);

  const handleAIEstimate = async (labor: LaborItem) => {
    if (!labor.taskName || !currentProject) return;
    const res = await predictTaskMandays(labor.taskName, labor.description, labor.role);
    if (res !== null) {
      const updated = currentProject.labors.map(l => l.id === labor.id ? { ...l, mandays: res } : l);
      updateProject({ labors: updated });
    }
  };

  const handleEstimateAll = async () => {
    if (!currentProject || currentProject.labors.length === 0) return;
    setIsEstimatingAll(true);
    try {
      const updatedLabors = [...currentProject.labors];
      for (let i = 0; i < updatedLabors.length; i++) {
        const labor = updatedLabors[i];
        if (labor.taskName) {
          const res = await predictTaskMandays(labor.taskName, labor.description, labor.role);
          if (res !== null) {
            updatedLabors[i] = { ...labor, mandays: res };
          }
        }
      }
      updateProject({ labors: updatedLabors });
    } catch (e) {
      console.error(e);
      alert("Lỗi khi ước lượng hàng loạt.");
    } finally {
      setIsEstimatingAll(false);
    }
  };

  const handleImportExcel = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const data = event.target?.result;
      const workbook = XLSX.read(data, { type: 'binary' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet) as any[];

      const newLabors: LaborItem[] = json.map((row, idx) => ({
        id: `l-import-${Date.now()}-${idx}`,
        taskName: row['Đầu việc'] || row['Task Name'] || row['Tên'] || '',
        role: mapStringToRole(row['Vai trò'] || row['Role'] || ''),
        mandays: parseFloat(row['Số công'] || row['Mandays'] || row['MD'] || '1'),
        description: row['Mô tả'] || row['Description'] || ''
      }));

      if (newLabors.length > 0) {
        updateProject({ labors: [...currentProject.labors, ...newLabors] });
        alert(`Đã nhập thành công ${newLabors.length} công việc.`);
      }
    };
    reader.readAsBinaryString(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleNavItemClick = (id: Tab) => {
    setActiveTab(id);
    setIsSidebarOpen(false);
  };

  const handleCreateNewProject = () => {
    const id = 'p'+Date.now();
    const n: Project = { 
      id, 
      name: 'Dự án mới', 
      servers: [], 
      labors: [], 
      infraPrices: INITIAL_UNIT_PRICES, 
      laborPrices: INITIAL_LABOR_PRICES, 
      createdAt: Date.now(), 
      lastModified: Date.now() 
    };
    setProjects([n, ...projects]);
    setCurrentProjectId(id);
    setIsDirty(true);
  };

  const handleDeleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Xóa dự án này?")) return;
    await deleteProjectFromCloud(id);
    const updatedProjects = projects.filter(p => p.id !== id);
    setProjects(updatedProjects);
    if (currentProjectId === id) {
      setCurrentProjectId(updatedProjects.length > 0 ? updatedProjects[0].id : null);
    }
  };

  if (isLoading) return <div className="min-h-screen bg-[#0F172A] flex items-center justify-center text-white font-black tracking-widest">KHỞI TẠO HỆ THỐNG...</div>;
  if (!currentProject) return <div className="min-h-screen flex items-center justify-center">Không tìm thấy dự án</div>;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col md:flex-row overflow-hidden font-sans">
      <aside className={`fixed inset-y-0 left-0 w-72 bg-[#0F172A] text-white z-[70] transition-transform md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} flex flex-col h-screen`}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-8">
            <span className="font-black text-2xl tracking-tighter">EstimaCore</span>
            <button onClick={() => setIsSidebarOpen(false)} className="md:hidden">×</button>
          </div>
          <nav className="space-y-1">
            <NavItem id="overview" label="Tổng quan" activeTab={activeTab} onClick={handleNavItemClick} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16m-7 6h7" strokeWidth="2" /></svg>} />
            <NavItem id="mandays" label="Nghiệp vụ" activeTab={activeTab} onClick={handleNavItemClick} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1z" strokeWidth="2" /></svg>} />
            <NavItem id="infra" label="Hạ tầng" activeTab={activeTab} onClick={handleNavItemClick} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2" strokeWidth="2" /></svg>} />
            <NavItem id="settings" label="Thiết lập" activeTab={activeTab} onClick={handleNavItemClick} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2" strokeWidth="2" /></svg>} />
          </nav>
        </div>
        <div className="mt-auto p-6 bg-slate-900/50">
          <p className="text-[10px] uppercase text-slate-500 font-bold mb-3">Dự án của bạn</p>
          <div className="max-h-48 overflow-y-auto mb-4 space-y-1">
            {projects.map(p => (
              <div key={p.id} className="relative group">
                <button onClick={() => setCurrentProjectId(p.id)} className={`w-full text-left px-3 py-2 rounded-lg text-xs truncate pr-8 ${currentProjectId === p.id ? 'bg-indigo-600 font-bold' : 'text-slate-400'}`}>{String(p.name)}</button>
                <button onClick={(e) => handleDeleteProject(p.id, e)} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-red-400 p-1">×</button>
              </div>
            ))}
          </div>
          <button onClick={handleCreateNewProject} className="w-full py-2 bg-slate-800 border border-white/10 rounded-lg text-xs font-bold transition-colors hover:bg-slate-700">+ Tạo dự án mới</button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-20 bg-white border-b border-slate-200 px-8 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 text-slate-600">
               <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16m-7 6h7" /></svg>
            </button>
            <input value={currentProject.name} onChange={(e) => updateProject({ name: e.target.value })} className="text-2xl font-black bg-transparent border-none outline-none w-80" placeholder="Tên dự án..." />
          </div>
          <div className="flex items-center gap-2">
             <button 
                onClick={() => exportProjectToExcel(currentProject)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-black hover:bg-indigo-100 transition-all"
             >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Xuất Excel
             </button>
             <button 
                onClick={handleSaveProject} 
                disabled={isSyncing}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-black transition-all ${isDirty ? 'bg-emerald-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400'}`}
             >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
                {isSyncing ? "Đang lưu..." : "Lưu dự án"}
             </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 pb-32">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm flex flex-col justify-between">
                  <span className="text-slate-400 font-bold text-[10px] uppercase">Hạ tầng Cloud</span>
                  <p className="text-2xl font-black text-indigo-600 mt-2">{formatCurrency(infraTotal)}</p>
                  <button onClick={() => setShowScriptModal(true)} className="mt-4 text-[10px] font-black text-indigo-400 uppercase tracking-widest hover:text-indigo-600">Lấy Script Triển khai →</button>
                </div>
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <span className="text-slate-400 font-bold text-[10px] uppercase">Nhân sự nghiệp vụ</span>
                  <p className="text-2xl font-black text-emerald-600 mt-2">{formatCurrency(manualLaborTotal + autoLaborTotal)}</p>
                </div>
                <div className="bg-indigo-600 p-6 rounded-3xl text-white shadow-xl shadow-indigo-200">
                  <span className="opacity-60 font-bold text-[10px] uppercase tracking-wider">Tổng dự toán tháng</span>
                  <p className="text-3xl font-black mt-2">{formatCurrency(grandTotal)}</p>
                  <button onClick={async () => {
                    setIsAnalyzing(true);
                    const res = await analyzeArchitecture(currentProject.servers, currentProject.labors);
                    setAnalysis(res);
                    setIsAnalyzing(false);
                  }} className="mt-4 w-full bg-white/20 hover:bg-white/30 px-4 py-2 rounded-xl text-xs font-black transition-all">
                    {isAnalyzing ? "Đang xử lý..." : "AI Tư vấn tối ưu"}
                  </button>
                </div>
              </div>
              {analysis && (
                <div className="bg-amber-50 border-2 border-amber-200 p-6 rounded-3xl">
                   <div className="flex justify-between items-center mb-2">
                     <span className="text-[10px] font-black text-amber-600 uppercase">Phản hồi từ AI Advisor</span>
                     <button onClick={() => setAnalysis(null)} className="text-amber-400 hover:text-amber-600 text-xl font-bold">×</button>
                   </div>
                   <p className="text-amber-900 text-sm whitespace-pre-line leading-relaxed font-medium">{String(analysis)}</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'mandays' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center flex-wrap gap-4">
                <div>
                  <h3 className="font-black text-xl">Nghiệp vụ Mandays</h3>
                  <button onClick={downloadImportTemplate} className="text-indigo-500 text-[10px] font-bold uppercase hover:underline">Tải file mẫu Excel (.xlsx)</button>
                </div>
                <div className="flex gap-2">
                  <input type="file" ref={fileInputRef} onChange={handleImportExcel} className="hidden" accept=".xlsx,.xls,.csv" />
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="bg-slate-100 text-slate-700 px-4 py-2 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                    Nhập Excel
                  </button>
                  <button 
                    onClick={handleEstimateAll}
                    disabled={isEstimatingAll}
                    className="bg-indigo-50 text-indigo-600 px-4 py-2 rounded-xl text-xs font-bold hover:bg-indigo-100 transition-all flex items-center gap-2 disabled:opacity-50"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    {isEstimatingAll ? "Đang ước lượng..." : "AI Estimate All"}
                  </button>
                  <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Task mới', role: Role.JuniorDev, mandays: 1, description: '' }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold">+ Thêm công việc</button>
                </div>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
                <table className="w-full text-left table-fixed">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                    <tr>
                      <th className="px-6 py-4 w-1/4">Đầu việc</th>
                      <th className="px-6 py-4 w-1/4">Mô tả</th>
                      <th className="px-6 py-4 w-1/6">Vai trò</th>
                      <th className="px-6 py-4 w-32 text-center">Số công</th>
                      <th className="px-6 py-4 w-1/6 text-right">Chi phí</th>
                      <th className="px-6 py-4 w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentProject.labors.map(l => (
                      <tr key={l.id} className="border-b border-slate-50 group hover:bg-slate-50">
                        <td className="px-6 py-4"><input className="w-full bg-transparent font-bold outline-none border-b border-transparent focus:border-indigo-300" value={l.taskName} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, taskName: e.target.value} : item)})} /></td>
                        <td className="px-6 py-4"><textarea className="w-full bg-transparent text-[11px] outline-none resize-none border-b border-transparent focus:border-indigo-300" rows={1} value={l.description} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, description: e.target.value} : item)})} /></td>
                        <td className="px-6 py-4">
                          <select className="bg-slate-100 px-3 py-1.5 rounded-lg text-xs w-full" value={l.role} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, role: e.target.value as Role} : item)})}>
                            {Object.values(Role).map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <input type="number" step="0.5" className="w-12 text-center bg-slate-100 rounded-lg py-1 text-xs" value={l.mandays} onChange={(e) => updateProject({ labors: currentProject.labors.map(item => item.id === l.id ? {...item, mandays: parseFloat(e.target.value) || 0} : item)})} />
                            <button onClick={() => handleAIEstimate(l)} className="text-indigo-500 font-black text-[10px] hover:scale-110 transition-transform">AI</button>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right font-black">{formatCurrency(calculateLaborCost(l, currentProject.laborPrices))}</td>
                        <td className="px-6 py-4"><button onClick={() => updateProject({ labors: currentProject.labors.filter(item => item.id !== l.id)})} className="text-red-400 opacity-0 group-hover:opacity-100 font-bold">×</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="bg-slate-900 rounded-3xl p-8 text-white">
                <h4 className="font-bold text-sm mb-4 text-slate-400 uppercase tracking-widest">Tự động (PM/BA/Tester tỷ lệ 3:1)</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  <div className="bg-white/5 p-4 rounded-2xl">
                    <p className="text-[10px] text-slate-500 font-bold uppercase mb-1">Project Manager</p>
                    <p className="text-xl font-black">{autoLaborStats.pm.toFixed(1)} MD <span className="text-xs text-indigo-400">({formatCurrency(autoLaborStats.pm * (currentProject.laborPrices[Role.PM] || 0))})</span></p>
                  </div>
                  <div className="bg-white/5 p-4 rounded-2xl">
                    <p className="text-[10px] text-slate-500 font-bold uppercase mb-1">Business Analyst</p>
                    <p className="text-xl font-black">{autoLaborStats.ba.toFixed(1)} MD <span className="text-xs text-indigo-400">({formatCurrency(autoLaborStats.ba * (currentProject.laborPrices[Role.BA] || 0))})</span></p>
                  </div>
                  <div className="bg-white/5 p-4 rounded-2xl">
                    <p className="text-[10px] text-slate-500 font-bold uppercase mb-1">Tester (QC)</p>
                    <p className="text-xl font-black">{autoLaborStats.tester.toFixed(1)} MD <span className="text-xs text-indigo-400">({formatCurrency(autoLaborStats.tester * (currentProject.laborPrices[Role.Tester] || 0))})</span></p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'infra' && (
            <div className="space-y-8">
              <div className="flex justify-between items-center">
                <h3 className="font-black text-xl">Hạ tầng Server</h3>
                <button onClick={() => updateProject({ servers: [...currentProject.servers, { id: 's'+Date.now(), category: Category.AppServer, os: 'Linux', configRaw: '4 core 8GB storage: 100GB', quantity: 1, content: 'Server mới', note: '', storageType: 'diskSanAllFlash', bwQt: 0, bwInternal: 0 }] })} className="bg-indigo-600 text-white px-6 py-2 rounded-xl text-xs font-bold transition-all hover:bg-indigo-700 shadow-lg">+ Thêm Server</button>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b">
                    <tr><th className="px-6 py-4">Tên dịch vụ</th><th className="px-6 py-4">Cấu hình</th><th className="px-6 py-4 text-center">SL</th><th className="px-6 py-4 text-right">Thành tiền</th><th className="px-6 py-4"></th></tr>
                  </thead>
                  <tbody>
                    {currentProject.servers.map(s => {
                      const cost = calculateItemCost(s, currentProject.infraPrices);
                      return (
                        <tr key={s.id} className="border-b border-slate-50 group hover:bg-slate-50">
                          <td className="px-6 py-4 font-bold"><input className="bg-transparent w-full outline-none" value={s.content} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, content: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4"><input className="w-full bg-slate-100 p-2 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-300" value={s.configRaw} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, configRaw: e.target.value} : item)})} /></td>
                          <td className="px-6 py-4 text-center"><input type="number" className="w-12 text-center bg-slate-100 rounded-lg py-1 text-xs outline-none" value={s.quantity} onChange={(e) => updateProject({ servers: currentProject.servers.map(item => item.id === s.id ? {...item, quantity: parseInt(e.target.value) || 1} : item)})} /></td>
                          <td className="px-6 py-4 text-right font-black text-indigo-600">{formatCurrency(cost.totalPrice)}</td>
                          <td className="px-6 py-4"><button onClick={() => updateProject({ servers: currentProject.servers.filter(item => item.id !== s.id)})} className="text-red-400 opacity-0 group-hover:opacity-100 font-bold hover:scale-125 transition-all">×</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-8 pb-10">
              {/* Cloud Configuration Section */}
              <div className="bg-indigo-900 text-white p-10 rounded-[40px] shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl"></div>
                <div className="relative z-10">
                   <div className="flex justify-between items-start mb-8">
                      <div>
                        <h3 className="text-2xl font-black">Cấu hình Cloud Sync</h3>
                        <p className="text-indigo-300 text-xs mt-1">Kết nối dự án tới Supabase của bạn.</p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <button 
                            onClick={handleCheckDb} 
                            className="px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all"
                        >
                            Kiểm tra kết nối
                        </button>
                        {dbStatus.status !== 'idle' && (
                            <div className={`text-[10px] font-bold ${dbStatus.status === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
                              {String(dbStatus.message || '')}
                            </div>
                        )}
                      </div>
                   </div>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase opacity-60">Supabase Project URL</label>
                        <input 
                          type="text" 
                          value={cloudConfig.url} 
                          onChange={(e) => setCloudConfig({...cloudConfig, url: e.target.value})}
                          placeholder="https://xxx.supabase.co"
                          className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-sm outline-none focus:bg-white/20 transition-all placeholder:text-white/20"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase opacity-60">Supabase Anon Key</label>
                        <input 
                          type="password" 
                          value={cloudConfig.key} 
                          onChange={(e) => setCloudConfig({...cloudConfig, key: e.target.value})}
                          placeholder="eyJhbG..."
                          className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-sm outline-none focus:bg-white/20 transition-all placeholder:text-white/20"
                        />
                      </div>
                   </div>
                   <div className="mt-8 flex items-center justify-between">
                      <p className="text-[10px] text-indigo-400 font-medium max-w-md italic">
                        Bạn có thể lấy các thông tin này tại: Project Settings  API trên Supabase Dashboard. 
                        Thông tin được lưu trong LocalStorage của trình duyệt.
                      </p>
                      <button 
                        onClick={handleSaveCloudConfig}
                        className="bg-emerald-500 hover:bg-emerald-600 text-white px-8 py-3 rounded-xl text-xs font-black shadow-lg transition-all"
                      >
                        Lưu cấu hình Cloud
                      </button>
                   </div>
                </div>
              </div>

              {/* Price Settings Sections */}
              <div className="bg-white p-10 rounded-[40px] border border-slate-200 shadow-xl">
                 <div className="mb-10">
                    <h3 className="text-2xl font-black">Thiết lập Đơn giá</h3>
                    <p className="text-slate-400 text-xs mt-1">Thay đổi đơn giá cơ sở cho hạ tầng và nhân sự.</p>
                 </div>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                   <div className="space-y-6">
                     <p className="text-xs font-black text-indigo-600 uppercase border-b pb-2 tracking-widest">Hạ tầng Cloud</p>
                     <PriceRow label="1 vCPU" value={currentProject.infraPrices.cpu} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, cpu: v}})} />
                     <PriceRow label="1 GB RAM" value={currentProject.infraPrices.ram} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, ram: v}})} />
                     <PriceRow label="SSD All Flash (GB)" value={currentProject.infraPrices.diskSanAllFlash} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, diskSanAllFlash: v}})} />
                     <PriceRow label="MinIO (GB)" value={currentProject.infraPrices.storageMinio} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, storageMinio: v}})} />
                     <PriceRow label="OS Windows" value={currentProject.infraPrices.osWindows} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, osWindows: v}})} />
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

        {/* Modal Script Triển Khai */}
        {showScriptModal && (
          <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
             <div className="bg-white rounded-[32px] w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[80vh] animate-in zoom-in duration-200">
                <div className="p-6 border-b flex justify-between items-center bg-slate-50">
                   <h3 className="font-black text-lg">Deployment Script</h3>
                   <button onClick={() => setShowScriptModal(false)} className="text-slate-400 hover:text-slate-600 text-2xl transition-colors">×</button>
                </div>
                <div className="p-6 overflow-y-auto bg-slate-50 flex-1">
                   <pre className="text-[11px] font-mono bg-slate-900 text-indigo-300 p-6 rounded-2xl whitespace-pre-wrap leading-relaxed border border-white/10 shadow-inner">
                      {String(deploymentScript)}
                   </pre>
                </div>
                <div className="p-6 border-t flex justify-end gap-2 bg-white">
                   <button 
                      onClick={() => {
                         navigator.clipboard.writeText(deploymentScript);
                         alert("Đã sao chép script vào Clipboard!");
                      }} 
                      className="px-6 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold transition-all hover:bg-indigo-700 active:scale-95"
                   >
                      Sao chép Script
                   </button>
                   <button 
                      onClick={() => setShowScriptModal(false)} 
                      className="px-6 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-200"
                   >
                      Đóng
                   </button>
                </div>
             </div>
          </div>
        )}

        <footer className="h-20 bg-[#0F172A] text-white px-8 flex items-center justify-between shrink-0 shadow-2xl relative z-20">
          <div className="flex gap-10">
            <div>
              <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Tổng lực lượng</p>
              <p className="text-xl font-black">{(autoLaborStats.devTotal + manualLaborTotal / (currentProject.laborPrices[Role.JuniorDev] || 1) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.tester).toFixed(1)} MD</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[8px] text-indigo-400 font-bold uppercase tracking-widest">TỔNG DỰ TOÁN THÁNG</p>
            <p className="text-2xl font-black">{formatCurrency(grandTotal)}</p>
          </div>
        </footer>
      </main>
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #F8FAFC; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #E2E8F0; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #CBD5E1; }
      `}} />
    </div>
  );
};

export default App;
