import test from 'node:test';
import { authFetch as fetch } from './auth-helper.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArchiveStore } from '../src/store.mjs';
import { createArchiveServer } from '../src/server.mjs';

const draft = (values = {}) => ({ id: randomUUID(), companyId: 'company-4', group: 'qualification', categoryIds: [], title: '验收档案', certificateNumber: '', issuingAuthority: '', issuedOn: '', originalCount: null, copyCount: null, scanCount: null, validityMode: 'unknown', validFrom: '', validUntil: '', transferPerson: '', departmentId: '', confidentialityLevel: '', retentionMode: 'unknown', retentionFrom: '', retentionUntil: '', storageLocation: '', remarks: '', numberingYear: '', isExample: false, recordVersion: 0, ...values });
const document = (code = '01', child = '01', overrides = {}) => draft({ group: 'document', categoryIds: [`cat-${code}`, ...(child ? [`cat-${code}-${child}`] : [])], ...overrides });
const editable = record => Object.fromEntries(Object.keys(draft()).map(key => [key, record[key]]));
const register = (store, value) => { const saved = store.createDraft(value); return store.register(saved.id, saved.recordVersion); };
const masterInput = master => ({ revision: master.revision, companies: master.companies, departments: master.departments, categories: master.categories });
const withStore = fn => { const store = new ArchiveStore(':memory:'); try { return fn(store); } finally { store.close(); } };
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);

test('source initialization is idempotent and contains only real master data', () => withStore(store => {
  const m = store.master(); assert.equal(m.companies.length, 33); assert.equal(m.companies.filter(c => !c.code).length, 3); assert.equal(m.categories.length, 24); assert.equal(m.departments.length, 0); assert.equal(store.list(new URLSearchParams()).total, 0);
}));

test('number scopes separate company, group, classification, deeper path and archive year', () => withStore(store => {
  assert.equal(register(store, draft()).archiveNumber, 'GF-ZZ-001');
  assert.equal(register(store, draft()).archiveNumber, 'GF-ZZ-002');
  assert.equal(register(store, document()).archiveNumber, 'GF-WS-01-01-001');
  assert.equal(register(store, document()).archiveNumber, 'GF-WS-01-01-002');
  assert.equal(register(store, document('01','09')).archiveNumber, 'GF-WS-01-09-001');
  assert.equal(register(store, draft({companyId:'company-5'})).archiveNumber, 'KJ-ZZ-001');
  assert.equal(register(store, document('20','',{numberingYear:'2026'})).archiveNumber, 'GF-WS-20-2026-001');
  assert.equal(register(store, document('20','',{numberingYear:'2026'})).archiveNumber, 'GF-WS-20-2026-002');
  assert.equal(register(store, document('20','',{numberingYear:'2027'})).archiveNumber, 'GF-WS-20-2027-001');
  assert.equal(register(store, document('09','01',{categoryIds:['cat-09','cat-09-01','cat-09-01-02']})).archiveNumber, 'GF-WS-09-01-02-001');
}));

test('registration retries are idempotent; void retains the number and cannot be edited', () => withStore(store => {
  const created = store.createDraft(draft()), registered = store.register(created.id, 1);
  assert.equal(store.register(created.id, 1).archiveNumber, registered.archiveNumber);
  const voided = store.void(created.id, registered.recordVersion, '误录');
  assert.equal(voided.archiveNumber, 'GF-ZZ-001'); assert.equal(voided.status, 'void');
  assert.equal(store.void(created.id, registered.recordVersion, '误录').recordVersion, voided.recordVersion);
  throwsCode(() => store.updateRecord(voided.id, editable(voided)), 'ARCHIVE_VOID');
  throwsCode(() => store.register(voided.id, voided.recordVersion), 'ARCHIVE_VOID');
  assert.equal(register(store, draft()).archiveNumber, 'GF-ZZ-002');
}));

test('numbering transaction rolls back counter and lifecycle together on failure', () => withStore(store => {
  const bad = store.createDraft(draft({ title:'故障样例' }));
  store.db.exec("CREATE TRIGGER fail_registration BEFORE UPDATE ON archives WHEN NEW.title='故障样例' AND NEW.status='registered' BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
  assert.throws(() => store.register(bad.id, 1));
  assert.equal(store.get(bad.id).status, 'draft'); assert.equal(store.db.prepare('SELECT count(*) AS c FROM numbering_counters').get().c, 0);
  store.db.exec('DROP TRIGGER fail_registration'); assert.equal(register(store, draft()).archiveNumber, 'GF-ZZ-001');
}));

test('counter grows beyond 999 without recycling', () => withStore(store => {
  register(store, draft()); store.db.prepare('UPDATE numbering_counters SET value=999').run();
  assert.equal(register(store, draft()).archiveNumber, 'GF-ZZ-1000');
}));

test('server validates dates, counts, taxonomy, department and missing numbering prerequisites', () => withStore(store => {
  for (const values of [{originalCount:-1},{copyCount:1.5},{issuedOn:'2026-02-30'},{issuedOn:'2026-99-01'},{validityMode:'fixed',validFrom:'2026-12-01',validUntil:'2026-01-01'},{retentionMode:'fixed',retentionUntil:''},{departmentId:'missing'},{isExample:true},{archiveNumber:'injected'}]) throwsCode(() => store.createDraft(draft(values)), 'VALIDATION_ERROR');
  const missing = store.createDraft(draft({companyId:'company-34'})); throwsCode(() => store.register(missing.id,1),'COMPANY_CODE_REQUIRED');
  const unresolved = store.createDraft(document('08','')); throwsCode(() => store.register(unresolved.id,1),'NUMBERING_RULE_UNRESOLVED');
  throwsCode(() => store.createDraft(document('01','')), 'VALIDATION_ERROR');
  throwsCode(() => store.createDraft(document('20','')), 'VALIDATION_ERROR');
  throwsCode(() => store.createDraft(document('01','01',{companyId:'company-5'})), 'VALIDATION_ERROR');
  const original = store.createDraft(draft({certificateNumber:'00123',originalCount:0,copyCount:null}));
  assert.equal(original.certificateNumber,'00123'); assert.equal(original.originalCount,0); assert.equal(original.copyCount,null);
  assert.ok(store.createDraft(draft({certificateNumber:'00123'})).warnings.length);
}));

test('optimistic versions prevent lost updates; registered identity and master codes are locked', () => withStore(store => {
  const first = store.createDraft(draft()), updated = store.updateRecord(first.id,{...editable(first),title:'更新'});
  throwsCode(() => store.updateRecord(first.id,{...editable(first),title:'过期版本'}), 'REVISION_CONFLICT');
  const official = store.register(updated.id,updated.recordVersion);
  throwsCode(() => store.updateRecord(official.id,{...editable(official),companyId:'company-5'}),'NUMBERING_FIELDS_LOCKED');
  assert.equal(store.updateRecord(official.id,{...editable(official),storageLocation:'A柜'}).archiveNumber,official.archiveNumber);
  const master = store.master(); master.companies[0].code='CHANGED'; throwsCode(() => store.saveMaster(masterInput(master)),'VALIDATION_ERROR');
  const snapshot = store.master(); const saved = store.saveMaster(masterInput(snapshot)); assert.equal(saved.revision,snapshot.revision+1);
  throwsCode(() => store.saveMaster(masterInput(snapshot)),'REVISION_CONFLICT');
  register(store,document()); const tree = store.master(); tree.categories[0].children[0].code='99'; throwsCode(() => store.saveMaster(masterInput(tree)),'VALIDATION_ERROR');
}));

test('phase2 migration is explicit, excludes examples, is repeatable and rolls back conflicts', () => withStore(store => {
  const master=store.master(), source={companies:master.companies,departments:[],categories:master.categories,records:[draft({title:'本机草稿'}),{isExample:true}]};
  assert.deepEqual(store.importPhase2(source),{imported:1,skipped:0,excludedExamples:1});
  assert.deepEqual(store.importPhase2(source),{imported:0,skipped:1,excludedExamples:1});
  const changed=structuredClone(source);changed.records[0].title='本机再次变更';throwsCode(()=>store.importPhase2(changed),'MIGRATION_CONFLICT');
  assert.equal(store.list(new URLSearchParams()).total,1);
  const batch=structuredClone(source);batch.records=[draft({title:'应回滚'}),draft({originalCount:-1})];throwsCode(()=>store.importPhase2(batch),'VALIDATION_ERROR');assert.equal(store.list(new URLSearchParams()).total,1);
}));

test('HTTP query, errors and field tampering behave correctly', async () => {
  const {server}=createArchiveServer({database:':memory:'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return {status:response.status,...await response.json()};};
  try {
    assert.equal((await request('/api/health')).status,200);
    const made=await request('/api/archive-drafts','POST',document('01','01',{title:'搜索样例',certificateNumber:'00123'}));assert.equal(made.status,200);
    const registered=await request(`/api/archive-drafts/${made.data.id}/register`,'POST',{recordVersion:1});assert.equal(registered.data.archiveNumber,'GF-WS-01-01-001');
    assert.equal((await request('/api/archives?keyword=GF-WS-01-01-001&status=registered')).data.total,1);
    assert.equal((await request('/api/archives?keyword=00123&category=cat-01')).data.total,1);
    assert.equal((await request('/api/archives?keyword='+encodeURIComponent("%' OR 1=1 --"))).data.total,0);
    assert.equal((await request('/api/archives?pageSize=1000')).status,422);
    assert.equal((await request('/api/archive-drafts','POST',draft({status:'registered'}))).status,422);
    assert.equal((await fetch(base+'/api/master-data',{method:'PUT',headers:{'Content-Type':'application/json',Origin:'http://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/api/archive-drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'})).status,400);
    assert.equal((await request('/api/archives/missing')).status,404);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

function startWorker(database) {
  const serverPath=fileURLToPath(new URL('../src/server.mjs',import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[serverPath],{windowsHide:true,env:{...process.env,ARCHIVE_DB_PATH:database,PORT:'0'},stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Worker startup timeout'));},15000);let output='';
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve({child,base:match[0]});}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);if(!output.includes('Archive API:'))reject(new Error('Worker exited '+code));});
  });
}
test('multiple independent processes allocate unique numbers; data survives restart', async () => {
  const folder=mkdtempSync(path.join(os.tmpdir(),'archive-phase3-')), database=path.join(folder,'test.sqlite');
  const workers=[];
  try {
    workers.push(await startWorker(database));workers.push(await startWorker(database));
    const numbers=await Promise.all(Array.from({length:24},async(_,i)=>{
      const base=workers[i%2].base;
      const made=await fetch(base+'/api/archive-drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft({title:`并发${i}`}))}).then(r=>r.json());assert.ok(made.data,made.error?.message);
      const numbered=await fetch(base+`/api/archive-drafts/${made.data.id}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recordVersion:1})}).then(r=>r.json());assert.ok(numbered.data,numbered.error?.message);return numbered.data.archiveNumber;
    }));
    assert.equal(new Set(numbers).size,24);assert.ok(numbers.includes('GF-ZZ-024'));
    for(const worker of workers)await new Promise(resolve=>{worker.child.once('exit',resolve);worker.child.kill();});workers.length=0;
    const reopened=new ArchiveStore(database);assert.equal(reopened.list(new URLSearchParams()).total,24);assert.equal(register(reopened,draft()).archiveNumber,'GF-ZZ-025');reopened.close();
  } finally {
    for(const worker of workers)worker.child.kill();
    assert.equal(path.dirname(path.resolve(database)),path.resolve(folder));
    for(const suffix of ['','-wal','-shm'])try{unlinkSync(database+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
    rmdirSync(folder);
  }
});
