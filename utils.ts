
import { createClient } from '@supabase/supabase-js';
import { ParsedConfig, ServerItem, UnitPrices, CalculationResult, LaborItem, LaborPrices, Project, Role } from './types';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';

export const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

export const parseConfig = (raw: string): ParsedConfig => {
  const config: ParsedConfig = { cpu: 0, ram: 0, storage: 0 };
  const cpuMatch = raw.match(/(\d+)\s*(core|CPU)/i);
  if (cpuMatch) config.cpu = parseInt(cpuMatch[1]);
  const ramMatch = raw.match(/(\d+)\s*(GB|GB RAM)/i);
  if (ramMatch) config.ram = parseInt(ramMatch[1]);
  const storagePart = raw.toLowerCase().split('storage:')[1] || '';
  const storageMatches = storagePart.match(/(\d+)\s*(gb|g|tb)/gi);
  if (storageMatches) {
    storageMatches.forEach(m => {
      const val = parseInt(m);
      if (m.toLowerCase().includes('tb')) config.storage += val * 1024;
      else config.storage += val;
    });
  } else {
    const fallbackMatch = raw.match(/(\d+)\s*(GB|G)\s*storage/i);
    if (fallbackMatch) config.storage = parseInt(fallbackMatch[1]);
  }
  return config;
};

export const calculateItemCost = (item: ServerItem, prices: UnitPrices): CalculationResult => {
  const config = parseConfig(item.configRaw);
  const isWindows = item.os.toLowerCase().includes('window');
  
  const cpuCost = (config.cpu || 0) * (prices.cpu || 0);
  const ramCost = (config.ram || 0) * (prices.ram || 0);
  
  const storagePriceUnit = prices[item.storageType] || prices.diskSanAllFlash || 0;
  const storageCost = (config.storage || 0) * storagePriceUnit;
  
  const bwQtCost = (item.bwQt || 0) * (prices.bandwidthQt || 0);
  const bwInternalCost = (item.bwInternal || 0) * (prices.bandwidthInternal || 0);
  
  const osCost = isWindows ? (prices.osWindows || 0) : (prices.osLinux || 0);
  
  const unitPrice = cpuCost + ramCost + storageCost + osCost + bwQtCost + bwInternalCost;
  return { unitPrice, totalPrice: unitPrice * item.quantity };
};

export const calculateLaborCost = (item: LaborItem, prices: LaborPrices): number => {
  const rate = prices[item.role] || 0;
  return (item.mandays || 0) * rate;
};

export const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0
  }).format(amount);
};

export const mapStringToRole = (str: string): Role => {
  const s = str.toLowerCase();
  if (s.includes('pm') || s.includes('manager')) return Role.PM;
  if (s.includes('ba') || s.includes('analyst')) return Role.BA;
  if (s.includes('senior') || (s.includes('dev') && s.includes('snr'))) return Role.SeniorDev;
  if (s.includes('junior') || s.includes('dev')) return Role.JuniorDev;
  if (s.includes('test') || s.includes('qa')) return Role.Tester;
  if (s.includes('design') || s.includes('ui') || s.includes('ux')) return Role.Designer;
  return Role.JuniorDev;
};

const PROJECTS_KEY = 'estimator_projects';

export const loadProjectsFromLocal = (): Project[] => {
  const data = localStorage.getItem(PROJECTS_KEY);
  return data ? JSON.parse(data) : [];
};

export const saveProjectToCloud = async (project: Project) => {
  const localProjects = loadProjectsFromLocal();
  const index = localProjects.findIndex(p => p.id === project.id);
  if (index >= 0) localProjects[index] = project;
  else localProjects.push(project);
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(localProjects));

  if (supabase) {
    const { error } = await supabase
      .from('projects')
      .upsert({
        id: project.id,
        name: project.name,
        servers: project.servers,
        labors: project.labors,
        infra_prices: project.infraPrices,
        labor_prices: project.laborPrices,
        created_at: project.createdAt,
        last_modified: project.lastModified
      });
    if (error) console.error("Cloud save error:", error);
  }
};

export const fetchProjectsFromCloud = async (): Promise<Project[]> => {
  if (!supabase) return loadProjectsFromLocal();

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('last_modified', { ascending: false });

  if (error) {
    console.error("Cloud fetch error:", error);
    return loadProjectsFromLocal();
  }

  return data.map(p => ({
    id: p.id,
    name: p.name,
    servers: p.servers,
    labors: p.labors,
    infraPrices: p.infra_prices,
    laborPrices: p.labor_prices,
    createdAt: p.created_at,
    lastModified: p.last_modified
  }));
};

export const deleteProjectFromCloud = async (id: string) => {
  const localProjects = loadProjectsFromLocal().filter(p => p.id !== id);
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(localProjects));

  if (supabase) {
    await supabase.from('projects').delete().eq('id', id);
  }
};
