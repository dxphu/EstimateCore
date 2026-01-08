
import { ServerItem, Category, UnitPrices, Role, LaborItem, TaskStatus, Priority, JournalEntry, JournalEntryType } from './types';

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

export const INITIAL_JOURNAL: JournalEntry[] = [
  {
    id: 'j1',
    type: JournalEntryType.Meeting,
    date: new Date().toISOString().split('T')[0],
    title: 'Họp khởi động dự án (Kick-off)',
    content: 'Chốt danh sách nhân sự tham gia và phân chia module chính cho các Team.'
  },
  {
    id: 'j2',
    type: JournalEntryType.Milestone,
    date: new Date(Date.now() + 86400000 * 7).toISOString().split('T')[0],
    title: 'Hoàn thành Prototype UI/UX',
    content: 'Khách hàng duyệt thiết kế giao diện mobile app và web admin.'
  }
];
