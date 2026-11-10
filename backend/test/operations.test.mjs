import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile,appendFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createArchiveServer } from '../src/server.mjs';
import { createBackup,verifyBackup,restoreBackup,inspectDatabase } from '../src/operations.mjs';
import { setupAdmin } from '../src/security.mjs';
import { requestContext } from '../src/access.mjs';
import { addAttachment } from '../src/attachments.mjs';
import { clientIP } from '../src/client-ip.mjs';
import { authFetch } from './auth-helper.mjs';

const draft=(patch={})=>({id:randomUUID(),companyId:'company-4',group:'qualification',categoryIds:[],title:'恢复验收',certificateNumber:'',issuingAuthority:'',issuedOn:'',originalCount:0,copyCount:null,scanCount:1,validityMode:'unknown',validFrom:'',validUntil:'',transferPerson:'',departmentId:'',confidentialityLevel:'',retentionMode:'unknown',retentionFrom:'',retentionUntil:'',storageLocation:'',remarks:'',numberingYear:'',isExample:false,recordVersion:0,...patch});
async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'archive-operations-'));
  const database=path.join(dir,'work.sqlite'),instance=createArchiveServer({database});
  const auth=setupAdmin(instance.store,{username:'restore-admin',displayName:'验收人',password:'Restore-fixture-password-2026'});
  const act=fn=>requestContext.run({user:auth.user,ip:'fixture',requestId:randomUUID()},fn);
  const record=act(()=>{const r=instance.store.createDraft(draft());return instance.store.register(r.id,r.recordVersion);});
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=','base64');
  const attachment=act(()=>addAttachment(instance.store,record.id,'扫描.png',bytes));
  t.after(async()=>{instance.store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,database,...instance,record,attachment,bytes,act};
}

test('online backup includes WAL, original files, accounts, counters and logs; restore resumes numbering and revokes sessions',async t=>{
  const f=await fixture(t),snapshot=await createBackup(f.database,path.join(f.dir,'backups'));
  assert.equal(snapshot.manifest.counts.archives,1);assert.equal(snapshot.manifest.counts.users,1);assert.equal(snapshot.manifest.counts.sessions,1);
  assert.equal(snapshot.manifest.counts.attachments,1);assert.ok(snapshot.manifest.counts.operation_logs>=3);
  f.act(()=>f.store.createDraft(draft({title:'备份之后的资料'})));
  const result=await restoreBackup(snapshot.folder,path.join(f.dir,'recovered.sqlite'));
  assert.equal(result.counts.archives,1);assert.equal(result.counts.sessions,0);assert.equal(result.counts.operation_logs,snapshot.manifest.counts.operation_logs+1);
  const recovered=createArchiveServer({database:result.target});
  try{
    assert.equal(recovered.store.get(f.record.id).archiveNumber,'GF-ZZ-001');
    assert.deepEqual(Buffer.from(recovered.store.db.prepare('SELECT content FROM attachments WHERE id=?').get(f.attachment.id).content),f.bytes);
    assert.equal(recovered.store.db.prepare('SELECT count(*) AS n FROM users').get().n,1);
    const next=recovered.store.createDraft(draft());assert.equal(recovered.store.register(next.id,next.recordVersion).archiveNumber,'GF-ZZ-002');
    assert.equal(recovered.store.db.prepare('SELECT password_hash FROM users').get().password_hash,f.store.db.prepare('SELECT password_hash FROM users').get().password_hash);
  }finally{recovered.store.close();}
});

test('restore never overwrites a live database or a SQLite sidecar',async t=>{
  const f=await fixture(t),snapshot=await createBackup(f.database,path.join(f.dir,'backups'));
  const before=await readFile(f.database);
  await assert.rejects(restoreBackup(snapshot.folder,f.database),/already exists/);
  assert.deepEqual(await readFile(f.database),before);
  const target=path.join(f.dir,'sidecar.sqlite');await writeFile(target+'-wal','keep');
  await assert.rejects(restoreBackup(snapshot.folder,target),/already exists/);
  assert.equal(await readFile(target+'-wal','utf8'),'keep');
});

test('corrupted backup and invalid manifest are rejected before restoring',async t=>{
  const f=await fixture(t),snapshot=await createBackup(f.database,path.join(f.dir,'backups'));
  await appendFile(path.join(snapshot.folder,'archive.sqlite'),'corrupt');
  await assert.rejects(restoreBackup(snapshot.folder,path.join(f.dir,'new.sqlite')),/checksum/);
  const bad=await createBackup(f.database,path.join(f.dir,'backups'));
  const manifest={...bad.manifest,database:'../work.sqlite'};await writeFile(path.join(bad.folder,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(verifyBackup(bad.folder),/manifest/);
});

test('attachment content integrity and newer schemas prevent unsafe backup or downgrade',async t=>{
  const f=await fixture(t);f.store.db.prepare('UPDATE attachments SET size=size+1').run();
  assert.throws(()=>inspectDatabase(f.database),/Attachment integrity/);
  await assert.rejects(createBackup(f.database,path.join(f.dir,'backups')),/Attachment integrity/);
  f.store.db.prepare("UPDATE metadata SET value='99' WHERE key='schema_version'").run();
  assert.throws(()=>createArchiveServer({database:f.database}),/newer/);
  assert.equal(f.store.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'99');
});

test('production serves hashed assets and same-origin authenticated API without exposing database/source paths',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'archive-static-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'public/assets'),{recursive:true});
  await writeFile(path.join(dir,'public/index.html'),'<h1>Production</h1>');await writeFile(path.join(dir,'public/assets/app-123.js'),'console.log(1)');
  await writeFile(path.join(dir,'private.json'),'{"secret":true}');
  const {server}=createArchiveServer({database:':memory:',staticDirectory:path.join(dir,'public')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(home.headers.get('cache-control'),'no-store');
  const asset=await fetch(base+'/assets/app-123.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);assert.match(asset.headers.get('cache-control'),/immutable/);
  const head=await fetch(base+'/',{method:'HEAD'});assert.equal(await head.text(),'');
  for(const name of ['/private.json','/.env','/assets/missing.js','/%2e%2e%2fprivate.json','/%00','/%5c..%5cprivate.json'])assert.equal((await fetch(base+name)).status,404,name);
  assert.equal((await fetch(base+'/api/archives')).status,401);
  const authenticated=await authFetch(base+'/api/bootstrap');assert.equal(authenticated.status,200);assert.equal((await authenticated.json()).data.currentUser.role,'admin');
});

test('proxy client address is trusted only with explicit configuration and a loopback peer',()=>{
  const req={socket:{remoteAddress:'127.0.0.1'},headers:{'x-real-ip':'10.20.30.40'}};
  assert.equal(clientIP(req),'127.0.0.1');assert.equal(clientIP(req,true),'10.20.30.40');
  assert.equal(clientIP({...req,socket:{remoteAddress:'10.2.3.4'}},true),'10.2.3.4');
  assert.equal(clientIP({...req,headers:{'x-real-ip':'spoof, 10.0.0.1'}},true),'127.0.0.1');
});

test('concurrent multi-user registrations retain unique numbers and content under load',async t=>{
  const {server,store}=createArchiveServer({database:':memory:'});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  await authFetch(base+'/api/bootstrap');
  const drafts=await Promise.all(Array.from({length:30},async(_,i)=>{
    const response=await authFetch(base+'/api/archive-drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft({title:'并发'+i}))});assert.equal(response.status,200);return (await response.json()).data;
  }));
  const numbers=await Promise.all(drafts.map(async record=>{
    const response=await authFetch(base+`/api/archives/${record.id}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recordVersion:record.recordVersion})});assert.equal(response.status,200);return (await response.json()).data.archiveNumber;
  }));
  assert.equal(new Set(numbers).size,30);assert.ok(numbers.includes('GF-ZZ-001'));assert.ok(numbers.includes('GF-ZZ-030'));assert.equal(store.list(new URLSearchParams()).total,30);
});
