
import { ServerItem, Category, UnitPrices, Role, LaborItem, LaborPrices } from './types';

export const INITIAL_UNIT_PRICES: UnitPrices = {
  // Compute (Theo ảnh)
  cpu: 166000,
  ram: 111000,
  // Disk (Theo ảnh)
  diskSanAllFlash: 754,
  diskSanAllFlashSme: 3683,
  diskVsan: 219,
  diskSanHdd: 150, // Ước tính vì ảnh trống
  // Storage (Theo ảnh)
  storageMinio: 18839,
  storageSmb3: 754,
  storageNfsVsan: 438,
  storageCeph: 166,
  // Network (Theo ảnh)
  bandwidthQt: 1850000,
  bandwidthInternal: 40000,
  // OS
  osWindows: 450000,
  osLinux: 0
};

export const INITIAL_LABOR_PRICES: LaborPrices = {
  [Role.PM]: 2500000,
  [Role.BA]: 2000000,
  [Role.SeniorDev]: 2200000,
  [Role.JuniorDev]: 1200000,
  [Role.Tester]: 1000000,
  [Role.Designer]: 1800000
};

export const INITIAL_SERVERS: ServerItem[] = [
  {
    id: 's1',
    category: Category.AppServer,
    os: 'Ubuntu Linux (64 bit)',
    configRaw: 'CPU: 8 core; RAM 16GB; storage: 100GB',
    quantity: 1,
    content: 'K8s Master Node',
    note: '',
    storageType: 'diskSanAllFlash',
    bwQt: 0,
    bwInternal: 10
  },
  {
    id: 's2',
    category: Category.DbServer,
    os: 'Centos7 (64 bit)',
    configRaw: 'CPU: 16 core; RAM 64GB; storage: 500GB',
    quantity: 2,
    content: 'Database Production Cluster',
    note: '',
    storageType: 'diskSanAllFlashSme',
    bwQt: 0,
    bwInternal: 20
  }
];

export const INITIAL_LABOR_ITEMS: LaborItem[] = [
  {
    id: 'l1',
    taskName: 'Phân tích nghiệp vụ (BA)',
    role: Role.BA,
    mandays: 10,
    description: 'Xác định yêu cầu chức năng'
  },
  {
    id: 'l2',
    taskName: 'Quản lý dự án (PM)',
    role: Role.PM,
    mandays: 5,
    description: 'Điều phối nhân sự'
  }
];
