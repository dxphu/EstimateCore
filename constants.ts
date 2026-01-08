
import { ServerItem, Category, UnitPrices, Role, LaborItem, TaskStatus, Priority } from './types';

export const INITIAL_UNIT_PRICES: UnitPrices = {
  cpu: 166000,
  ram: 111000,
  diskSanAllFlash: 754,
  diskSanAllFlashSme: 3683,
  diskVsan: 219,
  diskSanHdd: 150,
  storageMinio: 18839,
  storageSmb3: 754,
  storageNfsVsan: 438,
  storageCeph: 166,
  bandwidthQt: 1850000,
  bandwidthInternal: 40000,
  osWindows: 450000,
  osLinux: 0
};

export const INITIAL_LABOR_PRICES: { [key: string]: number } = {
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
  }
];

export const INITIAL_LABOR_ITEMS: LaborItem[] = [
  {
    id: 'l1',
    taskName: 'Phân tích nghiệp vụ (BA)',
    role: Role.BA,
    mandays: 10,
    description: 'Xác định yêu cầu chức năng',
    status: TaskStatus.Done,
    priority: Priority.High,
    assignee: 'Nguyễn Văn A',
    dueDate: new Date().toISOString().split('T')[0]
  },
  {
    id: 'l2',
    taskName: 'Thiết kế Database',
    role: Role.SeniorDev,
    mandays: 5,
    description: 'Thiết kế schema cho dự án',
    status: TaskStatus.Doing,
    priority: Priority.Urgent,
    assignee: 'Trần Thị B',
    dueDate: new Date().toISOString().split('T')[0]
  }
];
