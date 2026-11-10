import { z } from 'zod';

export const companySchema = z.object({ id: z.string(), name: z.string().min(1), code: z.string().nullable(), shortName: z.string(), enabled: z.boolean(), categoryEnabled: z.boolean() });
export const departmentSchema = z.object({ id: z.string(), companyId: z.string(), name: z.string().min(1), enabled: z.boolean() });
export type Category = { id: string; code: string; name: string; source: string; enabled: boolean; mode: 'continuous' | 'year' | 'unresolved'; children: Category[] };
export const categorySchema: z.ZodType<Category> = z.lazy(() => z.object({ id: z.string(), code: z.string(), name: z.string(), source: z.string(), enabled: z.boolean(), mode: z.enum(['continuous', 'year', 'unresolved']), children: z.array(categorySchema) }));
const count = z.number().int().nonnegative().nullable();
export const recordSchema = z.object({
  id: z.string(), companyId: z.string(), group: z.enum(['document', 'qualification']), categoryIds: z.array(z.string()), title: z.string(),
  certificateNumber: z.string(), issuingAuthority: z.string(), issuedOn: z.string(),
  originalCount: count, copyCount: count, scanCount: count,
  validityMode: z.enum(['fixed', 'permanent', 'na', 'unknown']), validFrom: z.string(), validUntil: z.string(),
  transferPerson: z.string(), departmentId: z.string(), confidentialityLevel: z.string(),
  retentionMode: z.enum(['fixed', 'permanent', 'unknown']), retentionFrom: z.string(), retentionUntil: z.string(),
  storageLocation: z.string(), remarks: z.string(), numberingYear: z.string(), isExample: z.boolean(), updatedAt: z.string(),
  status: z.enum(['draft', 'registered', 'void']).default('draft'),
  archiveNumber: z.string().nullable().default(null), recordVersion: z.number().int().nonnegative().default(0),
  createdAt: z.string().optional(), registeredAt: z.string().nullable().optional(), voidedAt: z.string().nullable().optional(), voidReason: z.string().default(''),
  registrationSnapshot: z.object({ companyName: z.string(), companyCode: z.string(), group: z.string(), categoryPath: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })), year: z.string().nullable(), sequence: z.number() }).nullable().optional(),
  warnings: z.array(z.string()).default([]),
});
export const userSchema=z.object({id:z.string(),username:z.string(),displayName:z.string(),role:z.enum(['admin','archivist','viewer']),companyIds:z.array(z.string()),levelIds:z.array(z.string()),canReadUnclassified:z.boolean(),canDownload:z.boolean(),canExport:z.boolean(),enabled:z.boolean(),userVersion:z.number()});
export type User=z.infer<typeof userSchema>;
export const roleLabels={admin:'系统管理员',archivist:'档案管理员',viewer:'查询人员'};
export const levelSchema=z.object({id:z.string(),name:z.string(),enabled:z.boolean(),levelVersion:z.number()});
export type ConfidentialityLevel=z.infer<typeof levelSchema>;
export const workspaceSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative().default(0), companies: z.array(companySchema), departments: z.array(departmentSchema), categories: z.array(categorySchema), records: z.array(recordSchema),confidentialityLevels:z.array(levelSchema).default([]),currentUser:userSchema.optional(),capabilities:z.object({manage:z.boolean(),write:z.boolean(),download:z.boolean(),export:z.boolean(),unclassified:z.boolean()}).default({manage:false,write:false,download:false,export:false,unclassified:false}) });
export type Company = z.infer<typeof companySchema>;
export type Department = z.infer<typeof departmentSchema>;
export type ArchiveRecord = z.infer<typeof recordSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export const groupLabels = { document: '文书档案类', qualification: '资质类（含证书）' };
export const validityLabels = { fixed: '有期限', permanent: '长期有效', na: '不适用', unknown: '待核实' };
export const retentionLabels = { fixed: '有期限', permanent: '长期保存', unknown: '待核实' };
export const statusLabels = { draft: '草稿', registered: '已登记', void: '已作废' };

export function resolvePath(categories: Category[], ids: string[]): Category[] {
  const result: Category[] = [];
  let options = categories;
  for (const id of ids) {
    const node = options.find(c => c.id === id);
    if (!node) break;
    result.push(node); options = node.children;
  }
  return result;
}
export function flattenCategories(categories: Category[], depth = 0): { node: Category; depth: number }[] {
  return categories.flatMap(node => [{ node, depth }, ...flattenCategories(node.children, depth + 1)]);
}
export function updateCategory(categories: Category[], id: string, update: (node: Category) => Category): Category[] {
  return categories.map(node => node.id === id ? update(node) : { ...node, children: updateCategory(node.children, id, update) });
}
export function createDraft(companyId: string, group: ArchiveRecord['group'] = 'document'): ArchiveRecord {
  return { id: crypto.randomUUID(), companyId, group, categoryIds: [], title: '', certificateNumber: '', issuingAuthority: '', issuedOn: '', originalCount: null, copyCount: null, scanCount: null, validityMode: group === 'document' ? 'na' : 'unknown', validFrom: '', validUntil: '', transferPerson: '', departmentId: '', confidentialityLevel: '', retentionMode: 'unknown', retentionFrom: '', retentionUntil: '', storageLocation: '', remarks: '', numberingYear: '', isExample: false, updatedAt: new Date().toISOString(), status: 'draft', archiveNumber: null, recordVersion: 0, voidReason: '', warnings: [] };
}
export function validateDraft(record: ArchiveRecord, state: Workspace): string | null {
  if(!record.confidentialityLevel&&!state.capabilities.unclassified)return '当前账号未获未定密档案授权，请选择已授权的秘密等级。';
  if(record.confidentialityLevel&&!state.confidentialityLevels.some(l=>l.id===record.confidentialityLevel&&(l.enabled||record.status==='registered')))return '请选择可用且已授权的秘密等级。';
  const company = state.companies.find(c => c.id === record.companyId);
  const registered = record.status === 'registered';
  if (!company || (!registered && !company.enabled)) return '请选择启用中的所属公司。';
  if (!record.title.trim()) return '请填写档案名称。';
  if (record.group === 'document') {
    if (!registered && !company.categoryEnabled) return '该公司尚未启用文书目录，请先在公司管理中配置。';
    const path = resolvePath(state.categories, record.categoryIds);
    if (!path.length || path.length !== record.categoryIds.length || (!registered && path.some(c => !c.enabled))) return '请选择有效的档案分类。';
    if (!registered && path.at(-1)!.children.some(c => c.enabled)) return '请继续选择下级分类。';
    if (path[0].mode === 'year' && !/^[1-9]\d{3}$/.test(record.numberingYear)) return '请填写四位归档年份。';
  } else if (record.categoryIds.length) return '资质类暂不使用文书分类。';
  if (record.departmentId && !state.departments.some(d => d.id === record.departmentId && d.companyId === record.companyId && (registered || d.enabled))) return '请选择该公司启用中的移交部门。';
  for (const n of [record.originalCount, record.copyCount, record.scanCount]) if (n !== null && (!Number.isInteger(n) || n < 0)) return '数量必须为非负整数，未核实可以留空。';
  if (record.validityMode === 'fixed') {
    if (!record.validUntil) return '有期限的证件请填写到期日期。';
    if (record.validFrom && record.validFrom > record.validUntil) return '有效开始日期不得晚于到期日期。';
  }
  if (record.retentionMode === 'fixed') {
    if (!record.retentionUntil) return '有期限保存请填写保存终止日期。';
    if (record.retentionFrom && record.retentionFrom > record.retentionUntil) return '保存开始日期不得晚于终止日期。';
  }
  return null;
}
