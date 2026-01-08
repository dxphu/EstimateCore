import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { ParsedConfig, ServerItem, UnitPrices, CalculationResult, LaborItem, LaborPrices, Project, Role } from './types';

// ========================================================================
// CHÚ Ý: KHÔNG dán chuỗi "postgresql://..." vào đây.
// Hãy vào Supabase Dashboard > Settings > API để lấy URL và Anon Key.
// ========================================================================
const HARDCODED_URL = 'https://pggapuatkhocxihyuprx.supabase.co'; 
const HARDCODED_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnZ2FwdWF0a2hvY3hpaHl1cHJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4Mzg1ODYsImV4cCI6MjA4MzQxNDU4Nn0.I53sjZUgiS0ndCTii7_yVRLv5tAeCSCJKGrIwTfLn3k';
// ========================================================================

const getEnv = (key: string): string => {
  try {
    // Kiểm tra an toàn cho môi trường build/browser
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    return (env as any)[key] || '';
  } catch (e) {
    return '';
  }
};

const CLOUD_CONFIG_KEY = 'estimacore_cloud_config';

export interface CloudConfig {
  url: string;
  key: string;
}

export const getCloudConfig = (): CloudConfig => {
  // Ưu tiên thông tin dán trực tiếp trong code
  if (HARDCODED_URL && HARDCODED_KEY) {
    return { url: HARDCODED_URL, key: HARDCODED_KEY };
  }
  
  const saved = localStorage.getItem(CLOUD_CONFIG_KEY);
  if (saved) return JSON.parse(saved);
  
  return {
    url: getEnv('SUPABASE_URL'),
    key: getEnv('SUPABASE_ANON_KEY')
  };
};

export const saveCloudConfig = (config: CloudConfig) => {
  localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
};

let supabaseInstance: SupabaseClient | null = null;

export const getSupabase = (): SupabaseClient | null => {
  if (supabaseInstance) return supabaseInstance;
  const config = getCloudConfig();
  if (config.url && config.key) {
    // Khởi tạo client Supabase
    supabaseInstance = createClient(config.url, config.key);
    return supabaseInstance;
  }
  return null;
};

export const resetSupabaseInstance = () => {
  supabaseInstance = null;
};

export const checkSupabaseConnection = async (): Promise<{ success: boolean; message: string }> => {
  const client = getSupabase();
  if (!client) return { success: false, message: "Chưa cấu hình Supabase URL/Key. Vui lòng kiểm tra lại file utils.ts." };
  try {
    // Kiểm tra nhanh bằng cách gọi bảng projects
    const { error } = await client.from('projects').select('id').limit(1);
    if (error) throw error;
    return { success: true, message: "Kết nối Supabase Cloud thành công!" };
  } catch (err: any) {
    return { success: false, message: `Lỗi kết nối: ${err.message || 'Hãy đảm bảo bạn đã chạy SQL Script tạo bảng.'}` };
  }
};

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
  if (!prices) return { unitPrice: 0, totalPrice: 0 };
  const config = parseConfig(item.configRaw);
  const isWindows = (item.os || '').toLowerCase().includes('window');
  
  const cpuCost = (config.cpu || 0) * (prices.cpu || 0);
  const ramCost = (config.ram || 0) * (prices.ram || 0);
  
  const storagePriceUnit = prices[item.storageType] || prices.diskSanAllFlash || 0;
  const storageCost = (config.storage || 0) * storagePriceUnit;
  
  const bwQtCost = (item.bwQt || 0) * (prices.bandwidthQt || 0);
  const bwInternalCost = (item.bwInternal || 0) * (prices.bandwidthInternal || 0);
  
  const osCost = isWindows ? (prices.osWindows || 0) : (prices.osLinux || 0);
  
  const unitPrice = cpuCost + ramCost + storageCost + osCost + bwQtCost + bwInternalCost;
  return { unitPrice, totalPrice: unitPrice * (item.quantity || 1) };
};

export const calculateLaborCost = (item: LaborItem, prices: LaborPrices): number => {
  if (!prices || !item) return 0;
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
  const s = (str || '').toLowerCase();
  if (s.includes('pm') || s.includes('manager')) return Role.PM;
  if (s.includes('ba') || s.includes('analyst')) return Role.BA;
  if (s.includes('senior')) return Role.SeniorDev;
  if (s.includes('test') || s.includes('qa')) return Role.Tester;
  if (s.includes('design') || s.includes('ui')) return Role.Designer;
  return Role.JuniorDev;
};

const PROJECTS_KEY = 'estimator_projects';

export const loadProjectsFromLocal = (): Project[] => {
  try {
    const data = localStorage.getItem(PROJECTS_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    return [];
  }
};

export const saveProjectToCloud = async (project: Project) => {
  const localProjects = loadProjectsFromLocal();
  const index = localProjects.findIndex(p => p.id === project.id);
  if (index >= 0) localProjects[index] = project;
  else localProjects.push(project);
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(localProjects));

  const client = getSupabase();
  if (client) {
    try {
      const { error } = await client.from('projects').upsert({
        id: project.id,
        name: project.name,
        servers: project.servers,
        labors: project.labors,
        infra_prices: project.infraPrices,
        labor_prices: project.laborPrices,
        created_at: project.createdAt,
        last_modified: project.lastModified
      });
      if (error) throw error;
    } catch (e) {
      console.error("Cloud save failed", e);
      throw e;
    }
  }
};

export const fetchProjectsFromCloud = async (): Promise<Project[]> => {
  const client = getSupabase();
  if (!client) return loadProjectsFromLocal();

  try {
    const { data, error } = await client
      .from('projects')
      .select('*')
      .order('last_modified', { ascending: false });

    if (error) throw error;

    return (data || []).map(p => ({
      id: p.id,
      name: p.name,
      servers: p.servers || [],
      labors: p.labors || [],
      infraPrices: p.infra_prices,
      laborPrices: p.labor_prices,
      createdAt: p.created_at,
      lastModified: p.last_modified
    }));
  } catch (err) {
    console.warn("Using local projects due to cloud fetch error", err);
    return loadProjectsFromLocal();
  }
};

export const deleteProjectFromCloud = async (id: string) => {
  const localProjects = loadProjectsFromLocal().filter(p => p.id !== id);
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(localProjects));

  const client = getSupabase();
  if (client) {
    try {
      await client.from('projects').delete().eq('id', id);
    } catch (e) {}
  }
};

export const exportProjectToExcel = (project: Project) => {
  const workbook = XLSX.utils.book_new();

  const serverData = project.servers.map(s => {
    const cost = calculateItemCost(s, project.infraPrices);
    return {
      'Tên dịch vụ': s.content,
      'Hệ điều hành': s.os,
      'Cấu hình': s.configRaw,
      'Số lượng': s.quantity,
      'Loại lưu trữ': s.storageType,
      'Băng thông QT (Mbps)': s.bwQt,
      'Băng thông Nội (Mbps)': s.bwInternal,
      'Đơn giá (VNĐ)': cost.unitPrice,
      'Thành tiền (VNĐ)': cost.totalPrice,
      'Ghi chú': s.note
    };
  });
  const serverSheet = XLSX.utils.json_to_sheet(serverData);
  XLSX.utils.book_append_sheet(workbook, serverSheet, 'Hạ tầng Cloud');

  const laborData = project.labors.map(l => ({
    'Đầu việc': l.taskName,
    'Vai trò': l.role,
    'Mô tả': l.description,
    'Số công (MD)': l.mandays,
    'Thành tiền (VNĐ)': calculateLaborCost(l, project.laborPrices)
  }));
  const laborSheet = XLSX.utils.json_to_sheet(laborData);
  XLSX.utils.book_append_sheet(workbook, laborSheet, 'Nghiệp vụ');

  XLSX.writeFile(workbook, `${project.name.replace(/\s+/g, '_')}_Cost_Estimator.xlsx`);
};

export const downloadImportTemplate = () => {
  const workbook = XLSX.utils.book_new();
  const templateData = [
    { 'Đầu việc': 'Xây dựng module đăng nhập', 'Mô tả': 'Thiết kế và code logic đăng nhập JWT', 'Vai trò': 'Senior Developer', 'Số công': 5 },
    { 'Đầu việc': 'Thiết kế Database', 'Mô tả': 'Thiết kế schema cho module quản lý kho', 'Vai trò': 'Business Analyst', 'Số công': 3 },
    { 'Đầu việc': 'Viết tài liệu HDSD', 'Mô tả': 'Hướng dẫn sử dụng cho người dùng cuối', 'Vai trò': 'Junior Developer', 'Số công': 2 }
  ];
  const worksheet = XLSX.utils.json_to_sheet(templateData);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Nghiệp vụ mẫu');
  XLSX.writeFile(workbook, 'Mau_Nhap_Nghiep_Vu_EstimaCore.xlsx');
};

export const generateDeploymentScript = (project: Project): string => {
  let script = `#!/bin/bash
# Deployment Script for Project: ${project.name}
# Generated on: ${new Date().toLocaleString()}

echo "Starting infrastructure provisioning for ${project.name}..."

`;

  project.servers.forEach((s, idx) => {
    const config = parseConfig(s.configRaw);
    script += `# --- Server ${idx + 1}: ${s.content} ---\n`;
    script += `echo "Provisioning ${s.quantity}x ${s.content} (${s.os})..." \n`;
    script += `echo "Config: ${config.cpu} vCPU, ${config.ram}GB RAM, ${config.storage}GB Disk (${s.storageType})" \n`;
    
    if (s.os.toLowerCase().includes('ubuntu') || s.os.toLowerCase().includes('linux')) {
      script += `# Example CLI Command\n`;
      script += `cloud-cli compute instance create --name "${s.content.replace(/\s+/g, '-')}" --cpu ${config.cpu} --ram ${config.ram} --disk ${config.storage} --image "${s.os}" --count ${s.quantity}\n`;
    } else {
      script += `# Manual provisioning required for Windows OS\n`;
    }
    script += `\n`;
  });

  script += `echo "Provisioning complete."\n`;
  return script;
};