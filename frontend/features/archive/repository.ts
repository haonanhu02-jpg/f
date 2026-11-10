import { z } from 'zod';
import { workspaceSchema, recordSchema,userSchema,levelSchema,type User,type Workspace,type ArchiveRecord } from './model';

export type ArchiveQuery = { company: string; group: string; keyword: string; category: string; department: string; validity: string; status: string; page: number; pageSize: number };
export const pageSchema = z.object({ records: z.array(recordSchema), total: z.number(), page: z.number(), pageSize: z.number(), stats: z.object({ draft: z.number(), registered: z.number(), void: z.number() }) });
export type ArchivePage = z.infer<typeof pageSchema>;
const envelopeSchema = z.object({ data: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), details: z.array(z.object({ field: z.string(), message: z.string() })).optional() }).optional() });
let csrfToken='';
function expired(){csrfToken='';window.dispatchEvent(new Event('archive:session-expired'));}

async function request(route: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  let response: Response;
  try { response = await fetch(`/api${route}`, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json','X-CSRF-Token':csrfToken }, body: body === undefined ? undefined : JSON.stringify(body), signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('无法连接档案服务，请确认后端已启动。'); }
  let result: z.infer<typeof envelopeSchema>;
  try { result = envelopeSchema.parse(await response.json()); } catch { throw new Error('档案服务响应异常，请确认后端已启动。'); }
  if (!response.ok) {
    if(response.status===401&&csrfToken)expired();
    const fields = result.error?.details?.map((d: { field: string; message: string }) => `${d.field}: ${d.message}`).join('；');
    throw new Error(fields ? `${result.error?.message} ${fields}` : result.error?.message || '操作失败，请重试。');
  }
  return result.data;
}
const editableKeys = ['id','companyId','group','categoryIds','title','certificateNumber','issuingAuthority','issuedOn','originalCount','copyCount','scanCount','validityMode','validFrom','validUntil','transferPerson','departmentId','confidentialityLevel','retentionMode','retentionFrom','retentionUntil','storageLocation','remarks','numberingYear','isExample','recordVersion'] as const;
function recordPayload(record: ArchiveRecord) { return Object.fromEntries(editableKeys.map(key => [key, record[key]])); }

export const archiveRepository = {
  async load(): Promise<Workspace> { return workspaceSchema.parse(await request('/bootstrap')); },
  async saveMaster(workspace: Workspace): Promise<Workspace> {
    await request('/master-data','PUT',{revision:workspace.revision,companies:workspace.companies,departments:workspace.departments,categories:workspace.categories});return this.load();
  },
  async list(query: ArchiveQuery, signal?: AbortSignal): Promise<ArchivePage> {
    const params = new URLSearchParams(); Object.entries(query).forEach(([key, value]) => { if (value !== '') params.set(key, String(value)); });
    return pageSchema.parse(await request(`/archives?${params}`, 'GET', undefined, signal));
  },
  async detail(id: string): Promise<ArchiveRecord> { return recordSchema.parse(await request(`/archives/${id}`)); },
  async saveRecord(record: ArchiveRecord): Promise<ArchiveRecord> {
    return recordSchema.parse(await request(record.recordVersion ? `/archives/${record.id}` : '/archive-drafts', record.recordVersion ? 'PATCH' : 'POST', recordPayload(record)));
  },
  async register(record: ArchiveRecord): Promise<ArchiveRecord> { return recordSchema.parse(await request(`/archive-drafts/${record.id}/register`, 'POST', { recordVersion: record.recordVersion })); },
  async void(record: ArchiveRecord, reason: string): Promise<ArchiveRecord> { return recordSchema.parse(await request(`/archives/${record.id}/void`, 'POST', { recordVersion: record.recordVersion, reason })); },
  localDraftCount(): number {
    const raw = localStorage.getItem('wansheng.archive.phase2.v1'); if (!raw) return 0;
    const data = workspaceSchema.parse(JSON.parse(raw)); return data.records.filter(r => !r.isExample).length;
  },
  async migrateLocal(): Promise<{ imported: number; skipped: number; excludedExamples: number }> {
    const raw = localStorage.getItem('wansheng.archive.phase2.v1'); if (!raw) throw new Error('此浏览器没有第二阶段的本机资料。');
    const local = workspaceSchema.parse(JSON.parse(raw));
    return z.object({ imported: z.number(), skipped: z.number(), excludedExamples: z.number() }).parse(await request('/migrations/phase2', 'POST', { companies: local.companies, departments: local.departments, categories: local.categories, records: local.records }));
  },
};

export const attachmentSchema=z.object({id:z.string(),archiveId:z.string(),name:z.string(),mime:z.string(),size:z.number(),sha256:z.string(),createdAt:z.string()});
export type Attachment=z.infer<typeof attachmentSchema>;
const importRowSchema=z.object({row:z.number(),title:z.string(),status:z.enum(['ready','imported','duplicate','error']),errors:z.array(z.string()),warnings:z.array(z.string())});
const importJobSchema=z.object({id:z.string(),committed:z.boolean(),total:z.number(),ready:z.number(),imported:z.number(),duplicates:z.number(),failed:z.number(),rows:z.array(importRowSchema)});
export type ImportJob=z.infer<typeof importJobSchema>;
export type ImportDefaults={companyId:string;group:string;categoryIds:string[];numberingYear:string};
async function upload(route:string,file:File){
  let response:Response;
  try{response=await fetch(`/api${route}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':csrfToken},body:file});}catch{throw new Error('文件上传失败，请确认档案服务已启动。');}
  if(response.status===401)expired();
  const result=envelopeSchema.parse(await response.json());if(!response.ok)throw new Error(result.error?.message||'文件上传失败。');return result.data;
}
export const fileRepository={
  async attachments(id:string){return z.array(attachmentSchema).parse(await request(`/archives/${id}/attachments`));},
  async uploadAttachment(id:string,file:File){return attachmentSchema.extend({duplicate:z.boolean()}).parse(await upload(`/archives/${id}/attachments?filename=${encodeURIComponent(file.name)}`,file));},
  attachmentUrl(id:string,download=false){return `/api/attachments/${id}/content${download?'?download=1':''}`;},
  async preview(file:File,defaults:ImportDefaults){const params=new URLSearchParams({filename:file.name,companyId:defaults.companyId,group:defaults.group,categoryIds:defaults.categoryIds.join(','),numberingYear:defaults.numberingYear});return importJobSchema.parse(await upload(`/excel/imports/preview?${params}`,file));},
  async commit(id:string){return importJobSchema.parse(await request(`/excel/imports/${id}/commit`,'POST',{}));},
  async download(route:string,name:string){
    const response=await fetch(`/api${route}`);if(response.status===401)expired();if(!response.ok){const result=envelopeSchema.parse(await response.json());throw new Error(result.error?.message||'下载失败。');}
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  },
};

const sessionSchema=z.object({setupRequired:z.boolean().optional(),user:userSchema.nullable(),csrfToken:z.string().optional()});
export const securityRepository={
  async session(){const data=sessionSchema.parse(await request('/auth/session'));csrfToken=data.csrfToken||'';return data;},
  async login(input:{username:string;password:string;displayName?:string},setup=false){const data=sessionSchema.parse(await request(setup?'/auth/setup':'/auth/login','POST',input));csrfToken=data.csrfToken||'';return data;},
  async logout(){await request('/auth/logout','POST',{});expired();},
  async password(oldPassword:string,newPassword:string){await request('/auth/password','POST',{oldPassword,newPassword});expired();},
  async users(){return z.array(userSchema).parse(await request('/security/users'));},
  async saveUser(id:string|null,data:Record<string,unknown>){return userSchema.parse(await request(id?`/security/users/${id}`:'/security/users',id?'PATCH':'POST',data));},
  async levels(){return z.array(levelSchema).parse(await request('/security/levels'));},
  async saveLevel(id:string|null,data:Record<string,unknown>){return levelSchema.parse(await request(id?`/security/levels/${id}`:'/security/levels',id?'PATCH':'POST',data));},
  async logs(page=1,action=''){return request(`/audit-logs?page=${page}&action=${encodeURIComponent(action)}`);},
  async analytics(days=30,company=''){return analyticsSchema.parse(await request(`/statistics?days=${days}&company=${encodeURIComponent(company)}`));},
};
const countGroup=z.object({id:z.string(),name:z.string(),count:z.number()});
export const analyticsSchema=z.object({today:z.string(),timeZone:z.string(),days:z.number(),total:z.number(),totals:z.object({draft:z.number(),registered:z.number(),void:z.number()}),groups:z.object({document:z.number(),qualification:z.number()}),byCompany:z.array(countGroup),byCategory:z.array(countGroup),reminders:z.array(z.object({id:z.string(),title:z.string(),companyId:z.string(),companyName:z.string(),archiveNumber:z.string(),type:z.enum(['validity','retention']),end:z.string(),remaining:z.number(),state:z.enum(['expired','today','soon'])}))});
export type Analytics=z.infer<typeof analyticsSchema>;
