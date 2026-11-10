import { z } from 'zod';

const id = z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/);
const text = (max = 200) => z.string().max(max);
const date = z.string().refine(v => v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1000 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v), '日期必须为真实的YYYY-MM-DD日期');
const count = z.number().int().min(0).max(1_000_000).nullable();
export const companySchema = z.object({ id, name: text(300).trim().min(1), code: z.string().max(30).regex(/^[A-Z][A-Z0-9]*$/).nullable(), shortName: text(100), enabled: z.boolean(), categoryEnabled: z.boolean() }).strict();
export const departmentSchema = z.object({ id, companyId: id, name: text(100).trim().min(1), enabled: z.boolean() }).strict();
export const categorySchema = z.lazy(() => z.object({ id, code: z.string().regex(/^\d{2}$/), name: text().trim().min(1), source: text(), enabled: z.boolean(), mode: z.enum(['continuous', 'year', 'unresolved']), children: z.array(categorySchema).max(200) }).strict());
export const editableSchema = z.object({
  id, companyId: id, group: z.enum(['document', 'qualification']), categoryIds: z.array(id).max(8), title: text().trim().min(1), certificateNumber: text(100), issuingAuthority: text(), issuedOn: date,
  originalCount: count, copyCount: count, scanCount: count,
  validityMode: z.enum(['fixed', 'permanent', 'na', 'unknown']), validFrom: date, validUntil: date,
  transferPerson: text(100), departmentId: text(120), confidentialityLevel: z.string().max(120),
  retentionMode: z.enum(['fixed', 'permanent', 'unknown']), retentionFrom: date, retentionUntil: date,
  storageLocation: text(), remarks: text(5000), numberingYear: z.string().max(4),
  isExample: z.literal(false), recordVersion: z.number().int().nonnegative().default(0),
}).strict();
export const masterSchema = z.object({ revision: z.number().int().positive(), companies: z.array(companySchema).min(1).max(1000), departments: z.array(departmentSchema).max(5000), categories: z.array(categorySchema).max(200) }).strict();
export const versionSchema = z.object({ recordVersion: z.number().int().positive() }).strict();
export const voidSchema = versionSchema.extend({ reason: text(1000).trim().min(1) }).strict();

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const reject = (message, code = 'VALIDATION_ERROR', status = 422) => { throw new ApiError(status, code, message); };
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, 'VALIDATION_ERROR', '提交内容不符合要求。', result.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })));
  return result.data;
}
export function findPath(categories, ids) {
  const result = []; let nodes = categories;
  for (const key of ids) { const node = nodes.find(n => n.id === key); if (!node) return []; result.push(node); nodes = node.children; }
  return result;
}
export function validateRecord(record, master, formal = false, allowInactive = false) {
  if(record.confidentialityLevel&&!(master.confidentialityLevels||[]).some(l=>l.id===record.confidentialityLevel&&(allowInactive||l.enabled)))reject('秘密等级不存在或已停用，请重新选择。');
  const company = master.companies.find(c => c.id === record.companyId);
  if (!company || (!allowInactive && !company.enabled)) reject('请选择启用中的所属公司。');
  let path = [];
  if (record.group === 'document') {
    if (!allowInactive && !company.categoryEnabled) reject('该公司尚未启用文书目录。');
    path = findPath(master.categories, record.categoryIds);
    if (!path.length || path.length !== record.categoryIds.length || (!allowInactive && path.some(n => !n.enabled))) reject('请选择有效的完整分类路径。');
    if (!allowInactive && path.at(-1).children.some(n => n.enabled)) reject('请继续选择下级分类。');
    if (path[0].mode === 'year' && !/^[1-9]\d{3}$/.test(record.numberingYear)) reject('年份类别必须填写四位归档年份。');
    if (path[0].mode !== 'year' && record.numberingYear !== '') reject('连续编号类别不应填写编号年份。');
    if (formal && path[0].mode === 'unresolved') reject('该分类的编号细则待明确，请先在分类管理中确认。', 'NUMBERING_RULE_UNRESOLVED');
  } else if (record.categoryIds.length || record.numberingYear) reject('资质类不使用文书分类或编号年份。');
  if (record.departmentId && !master.departments.some(d => d.id === record.departmentId && d.companyId === record.companyId && (allowInactive || d.enabled))) reject('移交部门不属于该公司或已停用。');
  if (record.validityMode === 'fixed') {
    if (!record.validUntil) reject('有期限的证件必须填写到期日期。');
    if (record.validFrom && record.validFrom > record.validUntil) reject('有效开始日期不得晚于到期日期。');
  } else if (record.validFrom || record.validUntil) reject('长期有效、不适用或待核实的证件不应保留有效期日期。');
  if (record.retentionMode === 'fixed') {
    if (!record.retentionUntil) reject('有期限保存必须填写终止日期。');
    if (record.retentionFrom && record.retentionFrom > record.retentionUntil) reject('保存开始日期不得晚于终止日期。');
  } else if (record.retentionUntil) reject('长期保存或待核实状态不应保留保存终止日期。');
  if (formal && !company.code) reject('公司编码待补，不能正式入账。', 'COMPANY_CODE_REQUIRED');
  return { company, path };
}
