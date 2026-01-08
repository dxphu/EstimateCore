
export enum Category {
  AppServer = "Server ứng dụng",
  DbServer = "Server database",
  Other = "Dịch vụ khác"
}

export enum Role {
  PM = "Project Manager",
  SeniorDev = "Senior Developer",
  JuniorDev = "Junior Developer",
  Tester = "Tester",
  QC = "Quality Control",
  Designer = "UI/UX Designer",
  BA = "Business Analyst"
}

export enum TaskStatus {
  Todo = "Chờ thực hiện",
  Doing = "Đang làm",
  Review = "Đang kiểm tra",
  Done = "Hoàn thành"
}

export enum Priority {
  Low = "Thấp",
  Medium = "Trung bình",
  High = "Cao",
  Urgent = "Khẩn cấp"
}

export enum JournalEntryType {
  Meeting = "Cuộc họp",
  Milestone = "Mốc quan trọng",
  Note = "Ghi chú"
}

export interface JournalEntry {
  id: string;
  type: JournalEntryType;
  date: string;
  title: string;
  content: string;
}

export interface UnitPrices {
  cpu: number;
  ram: number;
  diskSanAllFlash: number;
  diskSanAllFlashSme: number;
  diskVsan: number;
  diskSanHdd: number;
  storageMinio: number;
  storageSmb3: number;
  storageNfsVsan: number;
  storageCeph: number;
  bandwidthQt: number;
  bandwidthInternal: number;
  osWindows: number;
  osLinux: number;
}

export interface LaborPrices {
  [key: string]: number;
}

export type StorageType = 
  | 'diskSanAllFlash' 
  | 'diskSanAllFlashSme' 
  | 'diskVsan' 
  | 'diskSanHdd' 
  | 'storageMinio' 
  | 'storageSmb3' 
  | 'storageNfsVsan' 
  | 'storageCeph';

export interface ServerItem {
  id: string;
  category: Category;
  os: string;
  configRaw: string;
  quantity: number;
  content: string;
  note: string;
  storageType: StorageType;
  bwQt: number;
  bwInternal: number;
}

export interface LaborItem {
  id: string;
  taskName: string;
  role: Role;
  mandays: number;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assignee: string;
  dueDate: string;
}

export interface Project {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  servers: ServerItem[];
  labors: LaborItem[];
  journal?: JournalEntry[];
  infraPrices: UnitPrices;
  laborPrices: LaborPrices;
  createdAt: number;
  lastModified: number;
}

export interface ParsedConfig {
  cpu: number;
  ram: number;
  storage: number;
}

export interface CalculationResult {
  unitPrice: number;
  totalPrice: number;
}
