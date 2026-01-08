
export enum Category {
  AppServer = "Server ứng dụng",
  DbServer = "Server database",
  Other = "Dịch vụ khác"
}

export enum Role {
  PM = "Project Manager",
  SeniorDev = "Senior Developer",
  JuniorDev = "Junior Developer",
  Tester = "Tester/QA",
  Designer = "UI/UX Designer",
  BA = "Business Analyst"
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  picture: string;
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
}

export interface Project {
  id: string;
  name: string;
  servers: ServerItem[];
  labors: LaborItem[];
  infraPrices: UnitPrices;
  laborPrices: LaborPrices;
  createdAt: number;
  lastModified: number;
}

export interface GlobalSettings {
  defaultInfraPrices: UnitPrices;
  defaultLaborPrices: LaborPrices;
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
