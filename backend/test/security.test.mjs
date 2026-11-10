import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { createArchiveServer } from '../src/server.mjs';
import { addAttachment } from '../src/attachments.mjs';
import { analytics,shanghaiToday } from '../src/analytics.mjs';
import { requestContext } from '../src/access.mjs';
import { COLUMNS } from '../src/excel.mjs';
const PASS='Security-test-password-2026';
const draft=(patch={})=>({id:randomUUID(),companyId:'company-4',group:'qualification',categoryIds:[],title:'安全验收',certificateNumber:'',issuingAuthority:'',issuedOn:'',originalCount:1,copyCount:null,scanCount:null,validityMode:'unknown',validFrom:'',validUntil:'',transferPerson:'',departmentId:'',confidentialityLevel:'',retentionMode:'unknown',retentionFrom:'',retentionUntil:'',storageLocation:'',remarks:'',numberingYear:'',isExample:false,recordVersion:0,...patch});
const editable=r=>Object.fromEntries(Object.keys(draft()).map(k=>[k,r[k]]));
function client(base){let cookie='',csrf='';return async(route,method='GET',body,extra={})=>{
  const headers={...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':body instanceof Buffer?'application/octet-stream':'application/json','X-CSRF-Token':csrf}:{}),...extra};
  const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:body instanceof Buffer?body:JSON.stringify(body)});
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  const bytes=Buffer.from(await response.arrayBuffer());let result={};if(response.headers.get('content-type')?.includes('json'))result=JSON.parse(bytes.toString());if(result.data?.csrfToken)csrf=result.data.csrfToken;
  return {status:response.status,headers:response.headers,bytes,...result};
};}
async function withAPI(fn){const {server,store}=createArchiveServer({database:':memory:'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,admin=client(base);try{const setup=await admin('/api/auth/setup','POST',{username:'admin',displayName:'验收管理员',password:PASS});assert.equal(setup.status,200);return await fn({store,base,admin,setup});}finally{await new Promise(r=>server.close(r));}}
async function createUser(admin,patch={}){const result=await admin('/api/security/users','POST',{username:'reader',displayName:'验收查询人',password:PASS,role:'viewer',companyIds:['company-4'],levelIds:[],canReadUnclassified:false,canDownload:false,canExport:false,enabled:true,...patch});assert.equal(result.status,200,JSON.stringify(result));return result.data;}
async function loginUser(base,username){const api=client(base),result=await api('/api/auth/login','POST',{username,password:PASS});assert.equal(result.status,200,JSON.stringify(result));return api;}
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=','base64');

test('no default account, setup is one-time, cookies are HttpOnly and mutations require CSRF',async()=>{
  const {server,store}=createArchiveServer({database:':memory:'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,api=client(base);
  try{assert.equal((await api('/api/auth/session')).data.setupRequired,true);assert.equal((await api('/api/archives')).status,401);assert.equal(store.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
    const setup=await api('/api/auth/setup','POST',{username:'admin',displayName:'管理员',password:PASS});assert.equal(setup.status,200);assert.match(setup.headers.get('set-cookie'),/HttpOnly/);assert.match(setup.headers.get('set-cookie'),/SameSite=Strict/);
    assert.equal((await api('/api/auth/setup','POST',{username:'other',displayName:'其他',password:PASS})).status,409);
    assert.equal((await api('/api/archive-drafts','POST',draft(),{'X-CSRF-Token':''})).status,403);
    assert.equal((await api('/api/archive-drafts','POST',draft())).status,200);
    const row=store.db.prepare('SELECT password_hash FROM users').get();assert.notEqual(row.password_hash,PASS);assert.match(row.password_hash,/^[a-f0-9]+:[a-f0-9]+$/);
    const token=setup.headers.get('set-cookie').split(';')[0].split('=')[1];assert.notEqual(store.db.prepare('SELECT token_hash FROM sessions').get().token_hash,token);
    assert.equal((await client(base)('/api/archives','GET',undefined,{'X-User-Role':'admin'})).status,401);
  }finally{await new Promise(r=>server.close(r));}
});
test('company and exact-level grants filter list, detail, metadata, statistics and file bytes',()=>withAPI(async({store,base,admin})=>{
  const levelA=(await admin('/api/security/levels','POST',{name:'验收等级甲',enabled:true})).data,levelB=(await admin('/api/security/levels','POST',{name:'验收等级乙',enabled:true})).data;
  const a=store.createDraft(draft({title:'允许档案',confidentialityLevel:levelA.id})),b=store.createDraft(draft({title:'其他等级',confidentialityLevel:levelB.id})),unknown=store.createDraft(draft({title:'未定密'})),foreign=store.createDraft(draft({title:'其他公司',companyId:'company-5',confidentialityLevel:levelA.id}));
  const file=addAttachment(store,a.id,'file.png',PNG);await createUser(admin,{levelIds:[levelA.id]});const reader=await loginUser(base,'reader');
  const list=await reader('/api/archives');assert.equal(list.data.total,1);assert.equal(list.data.stats.draft,1);assert.equal((await reader(`/api/archives/${a.id}`)).status,200);
  for(const id of [b.id,unknown.id,foreign.id])assert.equal((await reader(`/api/archives/${id}`)).status,404);
  const boot=(await reader('/api/bootstrap')).data;assert.equal(boot.companies.length,1);assert.equal(boot.confidentialityLevels.length,1);assert.equal((await reader('/api/statistics')).data.total,1);assert.equal((await reader('/api/archives?company=company-5')).data.total,0);
  assert.equal((await reader(`/api/archives/${a.id}/attachments`)).status,200);assert.equal((await reader(`/api/attachments/${file.id}/content`)).status,403);assert.equal((await reader('/api/excel/export')).status,403);
  for(const route of ['/api/security/users','/api/audit-logs'])assert.equal((await reader(route)).status,403);
  assert.equal((await reader('/api/archive-drafts','POST',draft())).status,403);assert.equal((await reader(`/api/archives/${a.id}`,'PATCH',editable(a))).status,403);assert.equal((await reader(`/api/archive-drafts/${a.id}/register`,'POST',{recordVersion:1})).status,403);assert.equal((await reader('/api/migrations/phase2','POST',{})).status,403);
}));
test('archivist writes only allowed company/level, cannot downgrade unreadable records or manage accounts',()=>withAPI(async({store,base,admin})=>{
  const a=(await admin('/api/security/levels','POST',{name:'级别A',enabled:true})).data,b=(await admin('/api/security/levels','POST',{name:'级别B',enabled:true})).data;
  const hidden=store.createDraft(draft({confidentialityLevel:b.id}));await createUser(admin,{username:'editor',role:'archivist',levelIds:[a.id]});const editor=await loginUser(base,'editor');
  assert.equal((await editor('/api/archive-drafts','POST',draft())).status,403);
  const input=draft({confidentialityLevel:a.id}),made=await editor('/api/archive-drafts','POST',input);assert.equal(made.status,200);
  assert.equal((await editor(`/api/archives/${input.id}`,'PATCH',{...editable(made.data),companyId:'company-5'})).status,403);
  assert.equal((await editor(`/api/archives/${hidden.id}`,'PATCH',{...editable(hidden),confidentialityLevel:a.id})).status,404);
  assert.equal((await editor(`/api/archives/${input.id}/attachments?filename=file.png`,'POST',PNG)).status,200);
  assert.equal((await editor('/api/security/levels','POST',{name:'伪造',enabled:true})).status,403);assert.equal((await editor('/api/master-data','PUT',{})).status,403);
}));
test('granted file/export capabilities still respect record scope; export leaks no other company',()=>withAPI(async({store,base,admin})=>{
  const own=store.createDraft(draft({title:'可读'})),foreign=store.createDraft(draft({title:'不可读',companyId:'company-5'}));const file=addAttachment(store,own.id,'file.png',PNG),hidden=addAttachment(store,foreign.id,'other.png',PNG);
  await createUser(admin,{canReadUnclassified:true,canDownload:true,canExport:true});const reader=await loginUser(base,'reader');assert.equal((await reader(`/api/attachments/${file.id}/content`)).status,200);assert.equal((await reader(`/api/attachments/${hidden.id}/content`)).status,404);
  const output=await reader('/api/excel/export');assert.equal(output.status,200);const book=XLSX.read(output.bytes,{type:'buffer'}),rows=XLSX.utils.sheet_to_json(book.Sheets['档案台账']);assert.equal(rows.length,1);assert.equal(rows[0]['证件名称'],'可读');
}));
test('grant changes, password resets, disable, logout and password change revoke prior sessions',()=>withAPI(async({base,admin})=>{
  let user=await createUser(admin,{canReadUnclassified:true});let reader=await loginUser(base,'reader');
  const body={displayName:user.displayName,role:user.role,companyIds:user.companyIds,levelIds:user.levelIds,canReadUnclassified:false,canDownload:false,canExport:false,enabled:true,userVersion:user.userVersion};
  const changed=await admin(`/api/security/users/${user.id}`,'PATCH',body);assert.equal(changed.status,200);assert.equal((await reader('/api/archives')).status,401);
  reader=await loginUser(base,'reader');assert.equal((await reader('/api/auth/password','POST',{oldPassword:PASS,newPassword:'New-password-after-reset-2026'})).status,200);assert.equal((await reader('/api/archives')).status,401);
  assert.equal((await admin(`/api/security/users/${user.id}`,'PATCH',{...body,userVersion:changed.data.userVersion,enabled:false})).status,409);
  const fresh=(await admin('/api/security/users')).data.find(u=>u.id===user.id);const updated=await admin(`/api/security/users/${user.id}`,'PATCH',{...body,userVersion:fresh.userVersion,enabled:false});assert.equal(updated.status,200);assert.equal((await client(base)('/api/auth/login','POST',{username:'reader',password:'New-password-after-reset-2026'})).status,401);
  assert.equal((await admin('/api/auth/logout','POST',{})).status,200);assert.equal((await admin('/api/archives')).status,401);
}));
test('last enabled administrator cannot be removed and login failures are persisted and throttled',()=>withAPI(async({store,base,admin,setup})=>{
  const u=setup.data.user;assert.equal((await admin(`/api/security/users/${u.id}`,'PATCH',{displayName:u.displayName,role:'viewer',companyIds:[],levelIds:[],canReadUnclassified:false,canDownload:false,canExport:false,enabled:false,userVersion:u.userVersion})).status,422);
  const bad=client(base);for(let i=0;i<8;i++)assert.equal((await bad('/api/auth/login','POST',{username:'admin',password:'wrong-password'})).status,401);assert.equal((await bad('/api/auth/login','POST',{username:'admin',password:PASS})).status,429);
  const logs=store.db.prepare('SELECT detail FROM operation_logs').all().map(r=>r.detail).join('');assert.ok(!logs.includes(PASS));assert.ok(!logs.includes('wrong-password'));
  store.db.prepare('UPDATE auth_failures SET started_at=0').run();assert.equal((await bad('/api/auth/login','POST',{username:'admin',password:PASS})).status,200);
}));
test('level dictionary starts empty, disabling retains historical records and log rows are append-only',()=>withAPI(async({store,admin})=>{
  assert.equal((await admin('/api/security/levels')).data.length,0);const level=(await admin('/api/security/levels','POST',{name:'自定义级别',enabled:true})).data;
  let record=store.createDraft(draft({confidentialityLevel:level.id}));record=store.register(record.id,1);
  assert.equal((await admin(`/api/security/levels/${level.id}`,'PATCH',{name:level.name,enabled:false,levelVersion:level.levelVersion})).status,200);
  assert.equal((await admin(`/api/archives/${record.id}`,'PATCH',{...editable(record),storageLocation:'A柜'})).status,200);
  assert.equal((await admin('/api/archive-drafts','POST',draft({confidentialityLevel:level.id}))).status,422);
  assert.throws(()=>store.db.exec('DELETE FROM operation_logs'));assert.throws(()=>store.db.exec("UPDATE operation_logs SET action='changed'"));
  const logs=(await admin('/api/audit-logs?action=updated')).data.rows;assert.ok(logs.some(r=>r.detail.before&&r.detail.after&&r.detail.after.storageLocation==='A柜'));
}));
test('Excel jobs are owned by creator and reports cannot bypass company/level or export grants',()=>withAPI(async({base,admin})=>{
  await createUser(admin,{username:'editorone',role:'archivist',canReadUnclassified:true,canExport:true});await createUser(admin,{username:'editortwo',role:'archivist',canReadUnclassified:true,canExport:true});
  const first=await loginUser(base,'editorone'),second=await loginUser(base,'editortwo');const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([COLUMNS.map(c=>c[1]),COLUMNS.map(([k])=>({title:'导入授权',companyCode:'GF',group:'资质类（含证书）'})[k]||null),COLUMNS.map(([k])=>({title:'无权公司',companyCode:'KJ',group:'资质类（含证书）'})[k]||null)]),'档案导入');
  const preview=await first('/api/excel/imports/preview?filename=test.xlsx','POST',XLSX.write(book,{type:'buffer',bookType:'xlsx'}));assert.equal(preview.data.ready,1);assert.equal(preview.data.failed,1);const id=preview.data.id;
  assert.equal((await second(`/api/excel/imports/${id}/commit`,'POST',{})).status,404);assert.equal((await second(`/api/excel/imports/${id}/report`)).status,404);assert.equal((await first(`/api/excel/imports/${id}/commit`,'POST',{})).data.imported,1);
}));
test('Shanghai reminders classify expiry boundaries and exclude indefinite, drafts and void records',()=>withAPI(async({store,base,admin})=>{
  assert.equal(shanghaiToday(new Date('2026-11-08T16:05:00Z')),'2026-11-09');
  const add=(patch)=>{let r=store.createDraft(draft(patch));return store.register(r.id,1);};
  add({title:'昨天',validityMode:'fixed',validUntil:'2026-11-08'});add({title:'今天',validityMode:'fixed',validUntil:'2026-11-09'});add({title:'三十天',validityMode:'fixed',validUntil:'2026-12-09'});add({title:'三十一天',validityMode:'fixed',validUntil:'2026-12-10'});add({title:'长期',validityMode:'permanent'});add({title:'保存届满',retentionMode:'fixed',retentionUntil:'2026-11-09'});store.createDraft(draft({title:'草稿',validityMode:'fixed',validUntil:'2026-11-01'}));let voided=add({title:'作废',validityMode:'fixed',validUntil:'2026-11-01'});store.void(voided.id,voided.recordVersion,'误录');
  const data=analytics(store,new URLSearchParams('days=30'),{today:'2026-11-09'});assert.equal(data.reminders.length,4);assert.equal(data.reminders.filter(r=>r.state==='today').length,2);assert.equal(data.reminders.filter(r=>r.state==='expired').length,1);assert.equal(data.byCompany.reduce((n,c)=>n+c.count,0),data.total);assert.equal(data.byCategory.reduce((n,c)=>n+c.count,0),data.total);
  assert.equal(analytics(store,new URLSearchParams('days=7'),{today:'2026-11-09'}).reminders.length,3);assert.equal((await admin('/api/reminders?days=13')).status,422);
  await createUser(admin,{companyIds:['company-5'],canReadUnclassified:true});const reader=await loginUser(base,'reader');assert.equal((await reader('/api/statistics')).data.total,0);assert.equal((await reader('/api/reminders')).data.reminders.length,0);
}));
test('concurrent request contexts cannot bleed grants between two users',()=>withAPI(async({store,base,admin})=>{
  store.createDraft(draft({title:'GF'}));store.createDraft(draft({title:'KJ',companyId:'company-5'}));await createUser(admin,{username:'readerone',canReadUnclassified:true});await createUser(admin,{username:'readertwo',companyIds:['company-5'],canReadUnclassified:true});const first=await loginUser(base,'readerone'),second=await loginUser(base,'readertwo');
  const results=await Promise.all(Array.from({length:20},(_,i)=>(i%2?first:second)('/api/archives')));results.forEach((r,i)=>{assert.equal(r.data.records.length,1);assert.equal(r.data.records[0].title,i%2?'GF':'KJ');});
}));
