
import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { ServerItem, LaborItem, UnitPrices, LaborPrices, Category, Role, Project } from './types';
import { INITIAL_SERVERS, INITIAL_LABOR_ITEMS, INITIAL_UNIT_PRICES, INITIAL_LABOR_PRICES } from './constants';
import { calculateItemCost, calculateLaborCost, formatCurrency, parseConfig, saveProjectToCloud, fetchProjectsFromCloud, deleteProjectFromCloud, mapStringToRole } from './utils';
import { analyzeArchitecture, predictTaskMandays } from './geminiService';

type Tab = 'overview' | 'mandays' | 'infra' | 'settings';

const PriceRow: React.FC<{ label: string, value: number, onChange: (val: number) => void, unit?: string }> = ({ label, value, onChange, unit = "VNĐ" }) => (
  <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
    <span className="text-[11px] font-semibold text-slate-500 pr-2">{label}</span>
    <div className="flex items-center gap-2 flex-shrink-0">
      <input 
        type="number" 
        className="w-24 md:w-32 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-black text-right focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all" 
        value={value} 
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)} 
      />
      <span className="text-[9px] text-slate-400 font-bold w-10 uppercase">{unit}</span>
    </div>
  </div>
);

const App: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isBatchEstimating, setIsBatchEstimating] = useState(false);
  const [estimatingIds, setEstimatingIds] = useState<Set<string>>(new Set());
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const initData = async () => {
      try {
        setIsLoading(true);
        const cloudProjects = await fetchProjectsFromCloud();
        
        if (cloudProjects && cloudProjects.length > 0) {
          setProjects(cloudProjects);
          setCurrentProjectId(cloudProjects[0].id);
        } else {
          const firstProject: Project = {
            id: 'p1',
            name: 'Dự án Mẫu',
            servers: INITIAL_SERVERS,
            labors: INITIAL_LABOR_ITEMS,
            infraPrices: INITIAL_UNIT_PRICES,
            laborPrices: INITIAL_LABOR_PRICES,
            createdAt: Date.now(),
            lastModified: Date.now()
          };
          setProjects([firstProject]);
          setCurrentProjectId('p1');
          await saveProjectToCloud(firstProject);
        }
      } catch (err) {
        console.error("Initialization error:", err);
      } finally {
        setIsLoading(false);
      }
    };
    initData();
  }, []);

  const currentProject = useMemo(() => 
    projects.find(p => p.id === currentProjectId),
    [projects, currentProjectId]
  );

  const updateProject = async (updates: Partial<Project>) => {
    if (!currentProjectId || !currentProject) return;
    
    const updatedProject = { ...currentProject, ...updates, lastModified: Date.now() };
    setProjects(prev => prev.map(p => p.id === currentProjectId ? updatedProject : p));
    
    setIsSyncing(true);
    await saveProjectToCloud(updatedProject);
    setIsSyncing(false);
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
    return (currentProject.servers || []).reduce((sum, item) => {
      const cost = calculateItemCost(item, currentProject.infraPrices);
      return sum + (cost.totalPrice || 0);
    }, 0);
  }, [currentProject]);

  const manualLaborTotal = useMemo(() => {
    if (!currentProject) return 0;
    return (currentProject.labors || []).reduce((sum, item) => {
      return sum + calculateLaborCost(item, currentProject.laborPrices);
    }, 0);
  }, [currentProject]);

  const autoLaborTotal = useMemo(() => {
    if (!currentProject) return 0;
    const pmCost = autoLaborStats.pm * (currentProject.laborPrices[Role.PM] || 0);
    const baCost = autoLaborStats.ba * (currentProject.laborPrices[Role.BA] || 0);
    const testerCost = autoLaborStats.tester * (currentProject.laborPrices[Role.Tester] || 0);
    return pmCost + baCost + testerCost;
  }, [currentProject, autoLaborStats]);

  const laborTotal = manualLaborTotal + autoLaborTotal;
  const grandTotal = infraTotal + laborTotal;

  const handleAIEstimate = async (labor: LaborItem) => {
    if (!labor.taskName || estimatingIds.has(labor.id)) return;
    setEstimatingIds(prev => {
      const next = new Set(prev);
      next.add(labor.id);
      return next;
    });
    const result = await predictTaskMandays(labor.taskName, labor.description, labor.role);
    if (result !== null && currentProject) {
      const updatedLabors = currentProject.labors.map(l => l.id === labor.id ? { ...l, mandays: result } : l);
      await updateProject({ labors: updatedLabors });
    }
    setEstimatingIds(prev => {
      const next = new Set(prev);
      next.delete(labor.id);
      return next;
    });
  };

  const handleBatchAIEstimate = async () => {
    if (!currentProject || currentProject.labors.length === 0 || isBatchEstimating) return;
    setIsBatchEstimating(true);
    for (const labor of currentProject.labors) {
      if (labor.taskName.trim()) await handleAIEstimate(labor);
    }
    setIsBatchEstimating(false);
  };

  const createNewProject = async () => {
    const newId = 'p' + Math.random().toString(36).substr(2, 9);
    const newProject: Project = {
      id: newId,
      name: 'Dự án mới ' + (projects.length + 1),
      servers: [],
      labors: [],
      infraPrices: INITIAL_UNIT_PRICES,
      laborPrices: INITIAL_LABOR_PRICES,
      createdAt: Date.now(),
      lastModified: Date.now()
    };
    setProjects(prev => [newProject, ...prev]);
    setCurrentProjectId(newId);
    setActiveTab('overview');
    setIsSidebarOpen(false);
    await saveProjectToCloud(newProject);
  };

  const handleDeleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Bạn có chắc chắn muốn xóa dự án này?")) return;
    
    await deleteProjectFromCloud(id);
    const remaining = projects.filter(p => p.id !== id);
    setProjects(remaining);
    if (currentProjectId === id) {
      setCurrentProjectId(remaining.length > 0 ? remaining[0].id : null);
    }
  };

  const handleAnalyze = async () => {
    if (!currentProject) return;
    setIsAnalyzing(true);
    const res = await analyzeArchitecture(currentProject.servers, currentProject.labors);
    setAnalysis(res);
    setIsAnalyzing(false);
  };

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProject) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const bstr = evt.target?.result;
      if (typeof bstr !== 'string') return;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const wsname = wb.SheetNames[0];
      const ws = wb.Sheets[wsname];
      const data = XLSX.utils.sheet_to_json(ws) as any[];
      const newLabors: LaborItem[] = data.map((row, idx) => ({
        id: 'l_imp_' + Date.now() + '_' + idx,
        taskName: row["Tên đầu việc"] || row["Task Name"] || "Task mới",
        role: mapStringToRole(row["Vai trò"] || row["Role"] || ""),
        mandays: parseFloat(row["Số công"] || row["Mandays"] || 0),
        description: row["Mô tả"] || row["Description"] || ""
      }));
      await updateProject({ labors: [...currentProject.labors, ...newLabors] });
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsBinaryString(file);
  };

  const handleDownloadTemplate = () => {
    const templateData = [
      { "Tên đầu việc": "Thiết kế UI/UX", "Vai trò": "UI/UX Designer", "Số công": 5, "Mô tả": "Thiết kế trang chủ" },
      { "Tên đầu việc": "Phát triển API", "Vai trò": "Senior Developer", "Số công": 10, "Mô tả": "Xây dựng backend" }
    ];
    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mẫu Nhập Liệu");
    XLSX.writeFile(wb, "Mau_Du_Toan_Nghiep_Vu.xlsx");
  };

  const handleExportProjectExcel = () => {
    if (!currentProject) return;
    const summaryData = [
      { "Hạng mục": "Tên dự án", "Chi tiết": currentProject.name },
      { "Hạng mục": "Tổng chi phí hạ tầng", "Chi tiết": infraTotal },
      { "Hạng mục": "Tổng chi phí nhân sự", "Chi tiết": manualLaborTotal },
      { "Hạng mục": "Quản lý & QC", "Chi tiết": autoLaborTotal },
      { "Hạng mục": "TỔNG CỘNG", "Chi tiết": grandTotal },
      { "Hạng mục": "Tổng Mandays", "Chi tiết": autoLaborStats.devTotal }
    ];
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    const infraData = currentProject.servers.map(s => {
      const cost = calculateItemCost(s, currentProject.infraPrices);
      return {
        "Nội dung": s.content,
        "Cấu hình": s.configRaw,
        "Số lượng": s.quantity,
        "Đơn giá": cost.unitPrice,
        "Thành tiền": cost.totalPrice
      };
    });
    const wsInfra = XLSX.utils.json_to_sheet(infraData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsSummary, "Tổng hợp");
    XLSX.utils.book_append_sheet(wb, wsInfra, "Hạ tầng");
    XLSX.writeFile(wb, `Bao_Cao_${currentProject.name}.xlsx`);
  };

  const NavItem = ({ id, label, icon }: { id: Tab, label: string, icon: React.ReactNode }) => (
    <button
      onClick={() => { setActiveTab(id); setIsSidebarOpen(false); }}
      className={`flex flex-col md:flex-row items-center gap-1 md:gap-3 px-2 md:px-4 py-2 md:py-3 rounded-xl transition-all font-bold text-[10px] md:text-sm flex-1 md:flex-none ${activeTab === id ? 'text-indigo-600 md:bg-indigo-600 md:text-white shadow-none' : 'text-slate-400 md:text-slate-300 hover:bg-slate-800'}`}
    >
      <span>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );

  if (isLoading) return (
    <div className="min-h-screen bg-[#0F172A] flex flex-col items-center justify-center text-white">
      <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-6"></div>
      <p className="font-black text-xl">Đang kết nối Cloud...</p>
    </div>
  );

  if (!currentProject) return <div className="p-10 text-center font-bold text-slate-400">Không có dữ liệu.</div>;

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col md:flex-row font-sans text-slate-900 overflow-hidden">
      <aside className={`fixed inset-y-0 left-0 w-72 bg-[#0F172A] text-slate-300 transform transition-transform duration-300 ease-in-out z-[70] md:relative md:translate-x-0 flex flex-col h-screen border-r border-slate-800 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-2">
              <div className="bg-indigo-600 p-2 rounded-xl text-white shadow-lg">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              </div>
              <span className="font-black text-white text-xl">EstimaCore</span>
            </div>
            <button onClick={() => setIsSidebarOpen(false)} className="md:hidden">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <nav className="space-y-1">
            <NavItem id="overview" label="Tổng quan" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>} />
            <NavItem id="mandays" label="Nghiệp vụ" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>} />
            <NavItem id="infra" label="Hạ tầng" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2" /></svg>} />
            <NavItem id="settings" label="Đơn giá" icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37" /></svg>} />
          </nav>
        </div>
        <div className="mt-auto p-6 bg-slate-900/50">
          <p className="text-[10px] font-black uppercase text-slate-500 mb-3 tracking-widest">Dự án Cloud</p>
          <div className="space-y-1 mb-4 max-h-48 overflow-y-auto">
            {projects.map(p => (
              <div key={p.id} className="flex items-center group relative">
                <button onClick={() => setCurrentProjectId(p.id)} className={`flex-1 text-left px-3 py-2 rounded-xl text-xs truncate ${currentProjectId === p.id ? 'bg-indigo-600/20 text-indigo-400 font-bold' : 'text-slate-400'}`}>{p.name}</button>
                <button onClick={(e) => handleDeleteProject(p.id, e)} className="absolute right-2 opacity-0 group-hover:opacity-100 text-red-500">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9z" /></svg>
                </button>
              </div>
            ))}
          </div>
          <button onClick={createNewProject} className="w-full py-3 bg-indigo-600 text-white rounded-xl text-xs font-bold transition-all">+ Dự án mới</button>
        </div>
      </aside>
      <main className="flex-1 flex flex-col h-screen overflow-hidden relative">
        <header className="bg-white border-b border-slate-200 px-4 md:px-8 h-16 md:h-20 flex items-center justify-between sticky top-0 z-40">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 bg-slate-100 rounded-xl">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16m-7 6h7" /></svg>
            </button>
            <div className="flex flex-col">
              <input value={currentProject.name} onChange={(e) => updateProject({ name: e.target.value })} className="text-lg md:text-2xl font-black text-slate-800 bg-transparent border-none outline-none w-48 md:w-80 truncate" />
              {isSyncing && <span className="text-[9px] font-black text-emerald-500 animate-pulse uppercase">Đang đồng bộ Cloud...</span>}
            </div>
          </div>
          <div className="text-right hidden sm:block">
            <p className="text-[10px] text-slate-400 font-black uppercase">Dự toán tháng</p>
            <p className="text-xl font-black text-indigo-600">{formatCurrency(grandTotal)}</p>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-[#F8FAFC]">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <span className="text-slate-400 font-bold text-[10px] uppercase">Hạ tầng Cloud</span>
                  <p className="text-2xl font-black text-indigo-600 mt-2">{formatCurrency(infraTotal)}</p>
                </div>
                <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                  <span className="text-slate-400 font-bold text-[10px] uppercase">Nhân sự nghiệp vụ</span>
                  <p className="text-2xl font-black text-emerald-600 mt-2">{formatCurrency(laborTotal)}</p>
                </div>
                <div className="bg-indigo-600 p-6 rounded-3xl text-white shadow-xl">
                  <span className="opacity-60 font-bold text-[10px] uppercase">Tổng ngân sách</span>
                  <p className="text-3xl font-black mt-2">{formatCurrency(grandTotal)}</p>
                  <button onClick={handleAnalyze} disabled={isAnalyzing} className="mt-4 w-full bg-white/20 px-4 py-2 rounded-xl text-xs font-black">
                    {isAnalyzing ? "Đang xử lý..." : "Phân tích AI Advisor"}
                  </button>
                </div>
              </div>
              {analysis && (
                <div className="bg-amber-50 border-2 border-amber-200 p-6 rounded-3xl">
                  <p className="text-amber-900 text-sm whitespace-pre-line leading-relaxed">{analysis}</p>
                </div>
              )}
            </div>
          )}
          {activeTab === 'mandays' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h3 className="font-black text-slate-800 text-xl">Nghiệp vụ Mandays</h3>
                <div className="flex gap-2">
                  <button onClick={handleBatchAIEstimate} disabled={isBatchEstimating} className="bg-slate-900 text-white px-4 py-2.5 rounded-xl text-xs font-black">AI Dự toán hàng loạt</button>
                  <button onClick={() => updateProject({ labors: [...currentProject.labors, { id: 'l'+Date.now(), taskName: 'Task mới', role: Role.JuniorDev, mandays: 1, description: '' }] })} className="bg-emerald-600 text-white px-4 py-2.5 rounded-xl text-xs font-bold">+ Thêm việc</button>
                </div>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-x-auto">
                <table className="w-full text-left min-w-[800px]">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b border-slate-100">
                    <tr><th className="px-6 py-4">Đầu việc</th><th className="px-6 py-4">Vai trò</th><th className="px-6 py-4 text-center">Số công</th><th className="px-6 py-4 text-right">Chi phí</th><th className="px-6 py-4"></th></tr>
                  </thead>
                  <tbody>
                    {currentProject.labors.map(labor => (
                      <tr key={labor.id} className="border-b border-slate-50 group">
                        <td className="px-6 py-4"><input className="w-full bg-transparent font-bold outline-none" value={labor.taskName} onChange={(e) => updateProject({ labors: currentProject.labors.map(l => l.id === labor.id ? {...l, taskName: e.target.value} : l)})} /></td>
                        <td className="px-6 py-4">
                          <select className="bg-slate-100 px-3 py-1.5 rounded-lg text-xs" value={labor.role} onChange={(e) => updateProject({ labors: currentProject.labors.map(l => l.id === labor.id ? {...l, role: e.target.value as Role} : l)})}>
                            {Object.values(Role).map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-center gap-1">
                            <input type="number" className="w-12 text-center bg-slate-100 rounded-lg py-1 text-xs" value={labor.mandays} onChange={(e) => updateProject({ labors: currentProject.labors.map(l => l.id === labor.id ? {...l, mandays: parseFloat(e.target.value) || 0} : l)})} />
                            <button onClick={() => handleAIEstimate(labor)} className="text-indigo-500"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" /></svg></button>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right font-black">{formatCurrency(calculateLaborCost(labor, currentProject.laborPrices))}</td>
                        <td className="px-6 py-4 text-right opacity-0 group-hover:opacity-100"><button onClick={() => updateProject({ labors: currentProject.labors.filter(l => l.id !== labor.id)})} className="text-red-400">Xóa</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {activeTab === 'infra' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h3 className="font-black text-slate-800 text-xl">Hạ tầng Cloud</h3>
                <button onClick={() => updateProject({ servers: [...currentProject.servers, { id: 's'+Date.now(), category: Category.AppServer, os: 'Linux', configRaw: '2 core 4GB storage: 50GB', quantity: 1, content: 'Server mới', note: '', storageType: 'diskSanAllFlash', bwQt: 0, bwInternal: 0 }] })} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow-lg">+ Thêm Server</button>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-x-auto">
                <table className="w-full text-left min-w-[800px]">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 border-b border-slate-100">
                    <tr><th className="px-6 py-4">Dịch vụ</th><th className="px-6 py-4">Cấu hình</th><th className="px-6 py-4 text-center">SL</th><th className="px-6 py-4 text-right">Thành tiền</th><th className="px-6 py-4"></th></tr>
                  </thead>
                  <tbody>
                    {currentProject.servers.map(server => {
                      const cost = calculateItemCost(server, currentProject.infraPrices);
                      return (
                        <tr key={server.id} className="border-b border-slate-50 group">
                          <td className="px-6 py-4 font-bold">{server.content}</td>
                          <td className="px-6 py-4"><input className="w-full bg-slate-50 p-2 rounded-lg text-xs" value={server.configRaw} onChange={(e) => updateProject({ servers: currentProject.servers.map(s => s.id === server.id ? {...s, configRaw: e.target.value} : s)})} /></td>
                          <td className="px-6 py-4 text-center"><input type="number" className="w-12 text-center bg-slate-100 rounded-lg py-1 text-xs" value={server.quantity} onChange={(e) => updateProject({ servers: currentProject.servers.map(s => s.id === server.id ? {...s, quantity: parseInt(e.target.value) || 1} : s)})} /></td>
                          <td className="px-6 py-4 text-right font-black text-indigo-600">{formatCurrency(cost.totalPrice)}</td>
                          <td className="px-6 py-4 text-right opacity-0 group-hover:opacity-100"><button onClick={() => updateProject({ servers: currentProject.servers.filter(s => s.id !== server.id)})} className="text-red-400">Xóa</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {activeTab === 'settings' && (
            <div className="bg-white p-8 rounded-3xl shadow-xl border border-slate-200">
              <h3 className="font-black text-xl mb-6">Cấu hình Đơn giá</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                <div className="space-y-4">
                  <p className="text-xs font-black text-indigo-600 uppercase">Hạ tầng Cloud</p>
                  <PriceRow label="1 vCPU" value={currentProject.infraPrices.cpu} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, cpu: v}})} />
                  <PriceRow label="1 GB RAM" value={currentProject.infraPrices.ram} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, ram: v}})} />
                  <PriceRow label="SSD (GB)" value={currentProject.infraPrices.diskSanAllFlash} onChange={(v) => updateProject({ infraPrices: {...currentProject.infraPrices, diskSanAllFlash: v}})} />
                </div>
                <div className="space-y-4">
                  <p className="text-xs font-black text-emerald-600 uppercase">Nhân sự (Manday)</p>
                  {Object.values(Role).map(r => (
                    <PriceRow key={r} label={r} value={currentProject.laborPrices[r] || 0} onChange={(v) => updateProject({ laborPrices: {...currentProject.laborPrices, [r]: v}})} unit="VND/D" />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <footer className="fixed bottom-0 right-0 left-0 md:left-72 bg-[#0F172A] text-white p-4 flex items-center justify-between z-40">
          <div className="flex gap-6">
            <div className="flex flex-col">
              <span className="text-[8px] text-slate-500 font-bold uppercase">Mandays</span>
              <span className="text-lg font-black">{((currentProject.labors.reduce((a,b) => a + (b.mandays || 0), 0) + autoLaborStats.pm + autoLaborStats.ba + autoLaborStats.tester)).toFixed(1)}</span>
            </div>
          </div>
          <div className="text-right">
            <span className="text-[8px] text-indigo-400 font-bold uppercase">Tổng dự toán / Tháng</span>
            <p className="text-xl font-black">{formatCurrency(grandTotal)}</p>
          </div>
        </footer>
      </main>
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #F8FAFC; }
      `}} />
    </div>
  );
};

export default App;
