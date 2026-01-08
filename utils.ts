
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { ParsedConfig, ServerItem, UnitPrices, CalculationResult, LaborItem, LaborPrices, Project, Role, TaskStatus, Priority } from './types';

const HARDCODED_URL = 'https://pggapuatkhocxihyuprx.supabase.co'; 
const HARDCODED_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnZ2FwdWF0a2hvY3hpaHl1cHJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4Mzg1ODYsImV4cCI6MjA4MzQxNDU4Nn0.I53sjZUgiS0ndCTii7_yVRLv5tAeCSCJKGrIwTfLn3k';

const CLOUD_CONFIG_KEY = 'estimacore_cloud_config';

export interface CloudConfig {
  url: string;
  key: string;
}

export const getCloudConfig = (): CloudConfig => {
  if (HARDCODED_URL && HARDCODED_KEY) {
    return { url: HARDCODED_URL, key: HARDCODED_KEY };
  }
  const saved = localStorage.getItem(CLOUD_CONFIG_KEY);
  if (saved) return JSON.parse(saved);
  return { url: '', key: '' };
};

export const saveCloudConfig = (config: CloudConfig) => {
  localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
};

let supabaseInstance: SupabaseClient | null = null;

export const getSupabase = (): SupabaseClient | null => {
  if (supabaseInstance) return supabaseInstance;
  const config = getCloudConfig();
  if (config.url && config.key) {
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
  if (!client) return { success: false, message: "Chưa cấu hình Supabase." };
  try {
    const { error } = await client.from('projects').select('id').limit(1);
    if (error) throw error;
    return { success: true, message: "Kết nối thành công!" };
  } catch (err: any) {
    return { success: false, message: `Lỗi: ${err.message}` };
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
  if (s.includes('pm')) return Role.PM;
  if (s.includes('ba')) return Role.BA;
  if (s.includes('senior')) return Role.SeniorDev;
  if (s.includes('test')) return Role.Tester;
  if (s.includes('design')) return Role.Designer;
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

  const client = getSupabase();
  if (client) {
    const { error } = await client.from('projects').upsert({
      id: project.id,
      name: project.name,
      start_date: project.startDate,
      end_date: project.endDate,
      servers: project.servers,
      labors: project.labors,
      infra_prices: project.infraPrices,
      labor_prices: project.laborPrices,
      created_at: project.createdAt,
      last_modified: project.lastModified
    });
    if (error) console.error(error);
  }
};

export const fetchProjectsFromCloud = async (): Promise<Project[]> => {
  const client = getSupabase();
  if (!client) return loadProjectsFromLocal();
  try {
    const { data, error } = await client.from('projects').select('*').order('last_modified', { ascending: false });
    if (error) throw error;
    return (data || []).map(p => ({
      id: p.id,
      name: p.name,
      startDate: p.start_date,
      endDate: p.end_date,
      servers: p.servers || [],
      labors: p.labors || [],
      infraPrices: p.infra_prices,
      laborPrices: p.labor_prices,
      createdAt: p.created_at,
      lastModified: p.last_modified
    }));
  } catch (err) {
    return loadProjectsFromLocal();
  }
};

export const deleteProjectFromCloud = async (id: string) => {
  const localProjects = loadProjectsFromLocal().filter(p => p.id !== id);
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(localProjects));
  const client = getSupabase();
  if (client) await client.from('projects').delete().eq('id', id);
};

export const exportProjectToExcel = (project: Project) => {
  const workbook = XLSX.utils.book_new();

  // Tab Overview
  const overviewData = [{
    'Tên dự án': project.name,
    'Ngày bắt đầu': project.startDate || 'Chưa đặt',
    'Ngày kết thúc': project.endDate || 'Chưa đặt',
    'Ngày tạo': new Date(project.createdAt).toLocaleDateString(),
    'Cập nhật cuối': new Date(project.lastModified).toLocaleDateString()
  }];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(overviewData), 'Tổng quan');

  // Tab Infra
  const serverData = project.servers.map(s => {
    const cost = calculateItemCost(s, project.infraPrices);
    return {
      'Tên dịch vụ': s.content,
      'Cấu hình': s.configRaw,
      'Số lượng': s.quantity,
      'Thành tiền (VNĐ)': cost.totalPrice,
      'Ghi chú': s.note
    };
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(serverData), 'Hạ tầng');

  // Tab Planning
  const laborData = project.labors.map(l => ({
    'Đầu việc': l.taskName,
    'Mô tả': l.description,
    'Vai trò': l.role,
    'Số công (MD)': l.mandays,
    'Trạng thái': l.status,
    'Độ ưu tiên': l.priority,
    'Người thực hiện': l.assignee,
    'Hạn hoàn thành': l.dueDate
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(laborData), 'Kế hoạch chi tiết');

  XLSX.writeFile(workbook, `${project.name.replace(/\s+/g, '_')}_EstimaCore.xlsx`);
};

export const downloadImportTemplate = () => {
  const workbook = XLSX.utils.book_new();
  const templateData = [
    { 
      'Đầu việc': 'Phân tích nghiệp vụ', 
      'Mô tả': 'Khảo sát và lấy yêu cầu từ khách hàng', 
      'Vai trò': 'Business Analyst', 
      'Số công (MD)': 5
    },
    { 
      'Đầu việc': 'Thiết kế giao diện', 
      'Mô tả': 'Thiết kế UI/UX cho ứng dụng mobile', 
      'Vai trò': 'UI/UX Designer', 
      'Số công (MD)': 3
    },
    { 
      'Đầu việc': 'Phát triển API', 
      'Mô tả': 'Xây dựng backend service', 
      'Vai trò': 'Senior Developer', 
      'Số công (MD)': 10
    }
  ];
  const worksheet = XLSX.utils.json_to_sheet(templateData);
  
  // Set column widths
  const wscols = [
    { wch: 30 }, // Đầu việc
    { wch: 50 }, // Mô tả
    { wch: 20 }, // Vai trò
    { wch: 15 }, // Số công
  ];
  worksheet['!cols'] = wscols;

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Kế hoạch');
  XLSX.writeFile(workbook, 'Mau_Nhap_Ke_Hoach_EstimaCore.xlsx');
};

export const generateDeploymentScript = (project: Project): string => {
  let script = `#!/bin/bash\n# Deployment Script for ${project.name}\n\n`;
  project.servers.forEach((s, idx) => {
    const config = parseConfig(s.configRaw);
    script += `# ${idx + 1}. ${s.content}\n# vCPU: ${config.cpu}, RAM: ${config.ram}GB, Storage: ${config.storage}GB\n\n`;
  });
  return script;
};
