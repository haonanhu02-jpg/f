import { DatabaseSync, backup } from 'node:sqlite';
import { createReadStream, constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, unlink, rmdir, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const version=JSON.parse(await readFile(new URL('../version.json',import.meta.url),'utf8'));
const tables=['companies','departments','categories','archives','archive_categories','numbering_counters','archive_events','phase2_migrations','attachments','excel_import_jobs','users','sessions','auth_failures','confidentiality_levels','operation_logs'];
export async function sha256(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function inspectDatabase(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw new Error('Database integrity check failed.');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Database foreign key check failed.');
    const schemaVersion=Number(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value);
    if(schemaVersion!==version.schemaVersion)throw new Error(`Unsupported database schema ${schemaVersion}; expected ${version.schemaVersion}.`);
    const counts=Object.fromEntries(tables.map(table=>[table,Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)]));
    for(const file of db.prepare('SELECT id,size,sha256,content FROM attachments').iterate()){
      if(file.content.length!==file.size||createHash('sha256').update(file.content).digest('hex')!==file.sha256)throw new Error(`Attachment integrity check failed: ${file.id}`);
    }
    return {schemaVersion,counts};
  }finally{db.close();}
}
export async function createBackup(database,destination){
  if(!database||!destination)throw new Error('Database and destination are required.');
  const source=path.resolve(database),base=path.resolve(destination);
  if(!(await stat(source)).isFile())throw new Error('Source database is not a regular file.');
  await mkdir(base,{recursive:true,mode:0o700});
  const folder=await mkdtemp(path.join(base,new Date().toISOString().replace(/[:.]/g,'-')+'-'));
  await chmod(folder,0o700);
  const target=path.join(folder,'archive.sqlite');
  let db;
  try{
    db=new DatabaseSync(source,{readOnly:true});
    await backup(db,target);db.close();db=null;
    // Finalize a standalone snapshot, including WAL contents, before hashing it.
    const snapshot=new DatabaseSync(target);try{snapshot.exec('PRAGMA journal_mode=DELETE;');}finally{snapshot.close();}
    await chmod(target,0o600);
    const verified=inspectDatabase(target);
    const manifest={format:1,appVersion:version.version,createdAt:new Date().toISOString(),database:'archive.sqlite',sha256:await sha256(target),bytes:(await stat(target)).size,...verified};
    await writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    return {folder,manifest};
  }catch(error){
    if(db)db.close();
    for(const name of ['archive.sqlite','archive.sqlite-wal','archive.sqlite-shm','archive.sqlite-journal','manifest.json'])await unlink(path.join(folder,name)).catch(()=>{});
    await rmdir(folder).catch(()=>{});throw error;
  }
}
export async function verifyBackup(folder){
  const base=path.resolve(folder),manifest=JSON.parse(await readFile(path.join(base,'manifest.json'),'utf8'));
  if(manifest.format!==1||manifest.database!=='archive.sqlite'||manifest.schemaVersion!==version.schemaVersion||!/^[a-f0-9]{64}$/.test(manifest.sha256||''))throw new Error('Unsupported or invalid backup manifest.');
  const file=path.join(base,'archive.sqlite');
  if((await stat(file)).size!==manifest.bytes||await sha256(file)!==manifest.sha256)throw new Error('Backup checksum mismatch. Restore refused.');
  const verified=inspectDatabase(file);
  if(JSON.stringify(verified.counts)!==JSON.stringify(manifest.counts))throw new Error('Backup counts mismatch.');
  return {file,manifest};
}
export async function restoreBackup(folder,targetFile){
  if(!targetFile)throw new Error('A new target database path is required. Existing databases are never overwritten.');
  const {file,manifest}=await verifyBackup(folder),target=path.resolve(targetFile);
  await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  // Reserve a fresh path atomically. No destructive overwrite of a working database.
  // Sidecars also prohibit reuse of an existing database name.
  for(const suffix of ['','-wal','-shm','-journal']){
    try{await stat(target+suffix);throw new Error('Restore target or SQLite sidecar already exists; choose a fresh path.');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const stage=target+'.restore-'+randomUUID();
  try{
    await copyFile(file,stage,constants.COPYFILE_EXCL);await chmod(stage,0o600);
    const db=new DatabaseSync(stage);
    try{
      db.exec('BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM auth_failures;');
      db.prepare('INSERT INTO operation_logs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),'','系统恢复','database_restored','', '', '',JSON.stringify({backupCreatedAt:manifest.createdAt,backupSha256:manifest.sha256,sessionsRevoked:true}),new Date().toISOString(),'restore','local-maintenance');
      db.exec('COMMIT; PRAGMA journal_mode=DELETE;');
    }finally{db.close();}
    const verified=inspectDatabase(stage);
    await copyFile(stage,target,constants.COPYFILE_EXCL);await chmod(target,0o600);
    return {target,sourceBackupCreatedAt:manifest.createdAt,...verified,sessionsRevoked:true};
  }finally{
    for(const suffix of ['','-wal','-shm','-journal'])await unlink(stage+suffix).catch(()=>{});
  }
}
