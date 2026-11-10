import { randomBytes,randomUUID,scryptSync,timingSafeEqual,createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError,parse,reject } from './schema.mjs';
import { actor,requireAdmin,audit,requestContext } from './access.mjs';

export const COOKIE='archive_session';
const password=z.string().min(10,'密码至少10位').max(128);
const username=z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._-]{2,49}$/,'账号为3—50位小写字母、数字、点、下划线或短横线，以字母开头');
const setupSchema=z.object({username,displayName:z.string().trim().min(1).max(100),password}).strict();
const grantsSchema=z.object({displayName:z.string().trim().min(1).max(100),role:z.enum(['admin','archivist','viewer']),companyIds:z.array(z.string()).max(1000),levelIds:z.array(z.string()).max(200),canReadUnclassified:z.boolean(),canDownload:z.boolean(),canExport:z.boolean(),enabled:z.boolean()});
const digest=value=>createHash('sha256').update(value).digest('hex');
const hashPassword=value=>{const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(value,salt,64).toString('hex')}`;};
function verifyPassword(value,stored){const [salt,hash]=stored.split(':');const calculated=scryptSync(value,salt,64);return timingSafeEqual(calculated,Buffer.from(hash,'hex'));}
const dummyHash=hashPassword('dummy-password-never-used');
export function initializeSecurity(store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,policy TEXT NOT NULL,enabled INTEGER NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_failures(key TEXT PRIMARY KEY,count INTEGER NOT NULL,started_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS confidentiality_levels(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operation_logs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,username TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,company_id TEXT NOT NULL,level_id TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL,request_id TEXT NOT NULL,ip TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS logs_created ON operation_logs(created_at);
    CREATE TRIGGER IF NOT EXISTS logs_no_update BEFORE UPDATE ON operation_logs BEGIN SELECT RAISE(ABORT,'audit logs are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS logs_no_delete BEFORE DELETE ON operation_logs BEGIN SELECT RAISE(ABORT,'audit logs are append-only'); END;
    INSERT OR IGNORE INTO operation_logs SELECT 'legacy-'||e.id,'','历史记录',e.event_type,e.archive_id,a.company_id,COALESCE(json_extract(a.data,'$.confidentialityLevel'),''),e.detail,e.created_at,'legacy','' FROM archive_events e JOIN archives a ON a.id=e.archive_id;
    UPDATE metadata SET value='3' WHERE key='schema_version';`);
  const columns=store.db.prepare('PRAGMA table_info(excel_import_jobs)').all();if(!columns.some(c=>c.name==='owner_id'))store.db.exec("ALTER TABLE excel_import_jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
}
function publicUser(row){return {id:row.id,username:row.username,displayName:row.display_name,role:row.role,...JSON.parse(row.policy),enabled:!!row.enabled,userVersion:row.version};}
export function authStatus(store){return {setupRequired:!store.db.prepare('SELECT 1 FROM users LIMIT 1').get()};}
function newSession(store,user){const token=randomBytes(32).toString('hex'),csrfToken=randomBytes(32).toString('hex'),expiresAt=new Date(Date.now()+8*3600_000).toISOString();store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),user.id,csrfToken,expiresAt);return {token,csrfToken,user,expiresAt};}
export function sessionCookie(token,clear=false){return `${COOKIE}=${clear?'':token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:8*3600}${process.env.ARCHIVE_COOKIE_SECURE==='1'?'; Secure':''}`;}
export function setupAdmin(store,input){const data=parse(setupSchema,input);return store.transaction(()=>{
  if(!authStatus(store).setupRequired)throw new ApiError(409,'SETUP_COMPLETE','管理员已创建，请登录。');
  const id=randomUUID(),policy={companyIds:[],levelIds:[],canReadUnclassified:true,canDownload:true,canExport:true};
  store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,1,1,?)').run(id,data.username,data.displayName,'admin',hashPassword(data.password),JSON.stringify(policy),new Date().toISOString());
  const user=publicUser(store.db.prepare('SELECT * FROM users WHERE id=?').get(id));
  requestContext.run({...requestContext.getStore(),user},()=>audit(store,'admin_setup',id));return newSession(store,user);
});}
export function login(store,input,ip=''){
  const data=parse(z.object({username:z.string().max(100),password:z.string().max(128)}).strict(),input),name=data.username.trim().toLowerCase();
  return store.transaction(()=>{
    const keys=[{key:'account:'+name,limit:8},{key:'ip:'+ip,limit:50}];
    for(const {key,limit}of keys){const old=store.db.prepare('SELECT * FROM auth_failures WHERE key=?').get(key);if(old&&Date.now()-old.started_at<15*60_000&&old.count>=limit)return {error:new ApiError(429,'LOGIN_THROTTLED','登录尝试过多，请15分钟后重试。')};}
    const row=store.db.prepare('SELECT * FROM users WHERE username=?').get(name),valid=verifyPassword(data.password,row?.password_hash||dummyHash);
    if(!row||!row.enabled||!valid){for(const {key}of keys)store.db.prepare('INSERT INTO auth_failures VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN ?-started_at>900000 THEN 1 ELSE count+1 END,started_at=CASE WHEN ?-started_at>900000 THEN ? ELSE started_at END').run(key,Date.now(),Date.now(),Date.now(),Date.now());
      requestContext.run({...requestContext.getStore(),user:{id:row?.id||'',username:name}},()=>audit(store,'login_failed'));return {error:new ApiError(401,'LOGIN_FAILED','账号或密码错误。')};}
    store.db.prepare('DELETE FROM auth_failures WHERE key=?').run('account:'+name);
    const user=publicUser(row);requestContext.run({...requestContext.getStore(),user},()=>audit(store,'login'));return newSession(store,user);
  });
}
export function authenticate(store,req){
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!cookie||!/^[a-f0-9]{64}$/.test(cookie))throw new ApiError(401,'AUTH_REQUIRED','请先登录档案系统。');
  const row=store.db.prepare('SELECT s.csrf,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(digest(cookie));
  if(!row||!row.enabled||row.expires_at<=new Date().toISOString())throw new ApiError(401,'AUTH_REQUIRED','登录已失效，请重新登录。');
  if(requestContext.getStore())requestContext.getStore().user=publicUser(row);
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.headers['x-csrf-token']!==row.csrf)throw new ApiError(403,'CSRF_REQUIRED','会话校验失败，请刷新页面后重试。');
  return {user:publicUser(row),csrfToken:row.csrf,expiresAt:row.expires_at,tokenHash:digest(cookie)};
}
export function logout(store,session){audit(store,'logout',session.user.id);store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.tokenHash);}
export function users(store){requireAdmin();return store.db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(publicUser);}
function validateGrants(store,data){const master=store.master(),levels=levelsList(store);if(new Set(data.companyIds).size!==data.companyIds.length||data.companyIds.some(id=>!master.companies.some(c=>c.id===id)))reject('公司授权包含无效或重复条目。');if(new Set(data.levelIds).size!==data.levelIds.length||data.levelIds.some(id=>!levels.some(l=>l.id===id)))reject('密级授权包含无效或重复条目。');}
export function saveUser(store,id,input){requireAdmin();const data=parse(id?grantsSchema.extend({userVersion:z.number().int().positive(),password:password.optional()}).strict():grantsSchema.extend({username,password}).strict(),input);
  return store.transaction(()=>{validateGrants(store,data);const old=id?store.db.prepare('SELECT * FROM users WHERE id=?').get(id):null;if(id&&!old)throw new ApiError(404,'NOT_FOUND','账号不存在。');if(old&&old.version!==data.userVersion)throw new ApiError(409,'REVISION_CONFLICT','账号已修改，请刷新后重试。');
    if(old?.role==='admin'&&old.enabled&&(data.role!=='admin'||!data.enabled)&&store.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND enabled=1").get().n<=1)reject('必须保留至少一位启用中的系统管理员。');
    const target=id||randomUUID(),policy={companyIds:data.companyIds,levelIds:data.levelIds,canReadUnclassified:data.canReadUnclassified,canDownload:data.canDownload,canExport:data.canExport};
    if(old){store.db.prepare('UPDATE users SET display_name=?,role=?,policy=?,enabled=?,password_hash=?,version=version+1 WHERE id=?').run(data.displayName,data.role,JSON.stringify(policy),Number(data.enabled),data.password?hashPassword(data.password):old.password_hash,target);store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target);}
    else store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,1,?)').run(target,data.username,data.displayName,data.role,hashPassword(data.password),JSON.stringify(policy),Number(data.enabled),new Date().toISOString());
    const result=publicUser(store.db.prepare('SELECT * FROM users WHERE id=?').get(target));audit(store,old?'user_updated':'user_created',target,{before:old?publicUser(old):null,after:result,passwordReset:!!data.password});return result;
  });
}
export function changePassword(store,input){const data=parse(z.object({oldPassword:z.string().max(128),newPassword:password}).strict(),input);const user=actor();return store.transaction(()=>{const row=store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);if(!verifyPassword(data.oldPassword,row.password_hash))reject('原密码不正确。');store.db.prepare('UPDATE users SET password_hash=?,version=version+1 WHERE id=?').run(hashPassword(data.newPassword),user.id);store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);audit(store,'password_changed',user.id);return {changed:true};});}
export function levelsList(store){return store.db.prepare('SELECT id,name,enabled,version AS levelVersion FROM confidentiality_levels ORDER BY rowid').all().map(l=>({...l,enabled:!!l.enabled}));}
export function saveLevel(store,id,input){requireAdmin();const data=parse(z.object({name:z.string().trim().min(1).max(60),enabled:z.boolean(),...(id?{levelVersion:z.number().int().positive()}: {})}).strict(),input);return store.transaction(()=>{
  if(store.db.prepare('SELECT 1 FROM confidentiality_levels WHERE name=? AND id!=?').get(data.name,id||''))reject('秘密等级名称已存在。');
  const target=id||randomUUID(),old=id?store.db.prepare('SELECT * FROM confidentiality_levels WHERE id=?').get(id):null;if(id&&!old)throw new ApiError(404,'NOT_FOUND','秘密等级不存在。');if(old&&old.version!==data.levelVersion)throw new ApiError(409,'REVISION_CONFLICT','秘密等级已修改，请刷新。');
  if(old)store.db.prepare('UPDATE confidentiality_levels SET name=?,enabled=?,version=version+1 WHERE id=?').run(data.name,Number(data.enabled),target);else store.db.prepare('INSERT INTO confidentiality_levels VALUES(?,?,?,1)').run(target,data.name,Number(data.enabled));
  store.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();audit(store,old?'level_updated':'level_created',target,{name:data.name,enabled:data.enabled});return levelsList(store).find(l=>l.id===target);
});}
export function logList(store,query){requireAdmin();const page=Number(query.get('page')||1);if(!Number.isInteger(page)||page<1)reject('分页无效。');const action=query.get('action')||'',clauses=action?'WHERE action=?':'',args=action?[action]:[];const total=Number(store.db.prepare(`SELECT count(*) AS n FROM operation_logs ${clauses}`).get(...args).n);const rows=store.db.prepare(`SELECT * FROM operation_logs ${clauses} ORDER BY created_at DESC,rowid DESC LIMIT 50 OFFSET ?`).all(...args,(page-1)*50).map(row=>({...row,detail:JSON.parse(row.detail)}));return {rows,total,page,pageSize:50};}
