import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath,pathToFileURL } from 'node:url';
import path from 'node:path';
import { ArchiveStore } from './store.mjs';
import { ApiError,parse,versionSchema,voidSchema } from './schema.mjs';
import { initializeAttachments,listAttachments,addAttachment,attachmentContent,disposition,MAX_ATTACHMENT_SIZE } from './attachments.mjs';
import { initializeExcel,templateWorkbook,exportWorkbook,previewImport,commitImport,importReport,MAX_EXCEL_SIZE } from './excel.mjs';
import { initializeSecurity,authStatus,setupAdmin,login,authenticate,sessionCookie,logout,changePassword,users,saveUser,levelsList,saveLevel,logList } from './security.mjs';
import { requestContext,requireAdmin,audit } from './access.mjs';
import { analytics } from './analytics.mjs';
import { staticHandler } from './static.mjs';
import { clientIP } from './client-ip.mjs';

const defaultDB=fileURLToPath(new URL('../data/archive.sqlite',import.meta.url));
export function createArchiveServer({database=defaultDB,allowedOrigins=['http://127.0.0.1:5173','http://localhost:5173'],staticDirectory,trustProxy=false}={}){
  const serveStatic=staticHandler(staticDirectory);
  const store=new ArchiveStore(database);initializeAttachments(store);initializeExcel(store);initializeSecurity(store);
  const server=createServer((req,res)=>requestContext.run({requestId:randomUUID(),ip:clientIP(req,trustProxy)},async()=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,payload)=>{res.writeHead(status);res.end(JSON.stringify(payload));};
    const url=new URL(req.url,'http://127.0.0.1'),route=url.pathname;
    try{
      if(serveStatic?.(req,res,url))return;
      const origin=req.headers.origin;if(origin&&!allowedOrigins.includes(origin))throw new ApiError(403,'ORIGIN_NOT_ALLOWED','当前访问来源未获允许。');
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,PUT,PATCH,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range,X-CSRF-Token');res.writeHead(204);res.end();return;}
      if(req.method==='GET'&&route==='/api/health'){send(200,{data:{ok:true,database:'sqlite',schemaVersion:3,version:'1.0.0'}});return;}
      if(req.method==='GET'&&route==='/api/auth/status'){send(200,{data:authStatus(store)});return;}
      let session;
      if(!['/api/auth/setup','/api/auth/login'].includes(route)){
        if(req.method==='GET'&&route==='/api/auth/session'){
          try{session=authenticate(store,req);}catch(e){if(e.status!==401)throw e;send(200,{data:{...authStatus(store),user:null}});return;}
        }else session=authenticate(store,req);
        requestContext.getStore().user=session.user;
      }
      const attachmentRoute=route.match(/^\/api\/archives\/([A-Za-z0-9_-]+)\/attachments$/),binaryUpload=req.method==='POST'&&(attachmentRoute||route==='/api/excel/imports/preview');
      let body={},binary;
      if(binaryUpload){
        if(!req.headers['content-type']?.startsWith('application/octet-stream'))throw new ApiError(415,'BINARY_REQUIRED','请上传文件内容。');
        const limit=attachmentRoute?MAX_ATTACHMENT_SIZE:MAX_EXCEL_SIZE,buffers=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw new ApiError(413,'PAYLOAD_TOO_LARGE',attachmentRoute?'单个附件最大20MB。':'Excel最大10MB。');buffers.push(chunk);}binary=Buffer.concat(buffers);
      }else if(['POST','PUT','PATCH'].includes(req.method)){
        if(!req.headers['content-type']?.startsWith('application/json'))throw new ApiError(415,'JSON_REQUIRED','请提交JSON格式内容。');
        const buffers=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>5_000_000)throw new ApiError(413,'PAYLOAD_TOO_LARGE','提交内容过大。');buffers.push(chunk);}try{body=JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{throw new ApiError(400,'INVALID_JSON','JSON内容无效。');}
      }
      if(session&&['POST','PUT','PATCH','DELETE'].includes(req.method)){session=authenticate(store,req);requestContext.getStore().user=session.user;}
      if(req.method==='POST'&&['/api/auth/setup','/api/auth/login'].includes(route)){
        const result=route.endsWith('/setup')?setupAdmin(store,body):login(store,body,requestContext.getStore().ip);if(result.error)throw result.error;
        res.setHeader('Set-Cookie',sessionCookie(result.token));send(200,{data:{user:result.user,csrfToken:result.csrfToken,expiresAt:result.expiresAt}});return;
      }
      const sendWorkbook=(bytes,name)=>{res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':disposition(name),'Content-Length':bytes.length});res.end(bytes);};
      if(req.method==='GET'&&route==='/api/excel/template'){sendWorkbook(templateWorkbook(store),'档案导入模板.xlsx');audit(store,'excel_template');return;}
      if(req.method==='GET'&&route==='/api/excel/export'){sendWorkbook(exportWorkbook(store,url.searchParams),'档案台账.xlsx');return;}
      const report=route.match(/^\/api\/excel\/imports\/([A-Za-z0-9_-]+)\/report$/);
      if(req.method==='GET'&&report){sendWorkbook(importReport(store,report[1]),'档案导入结果.xlsx');audit(store,'import_report',report[1]);return;}
      const attachmentFile=route.match(/^\/api\/attachments\/([A-Za-z0-9_-]+)\/content$/);
      if(['GET','HEAD'].includes(req.method)&&attachmentFile){
        const file=attachmentContent(store,attachmentFile[1]);let start=0,end=file.size-1,status=200;
        if(req.headers.range){const range=req.headers.range.match(/^bytes=(\d*)-(\d*)$/);if(!range||(!range[1]&&!range[2]))throw new ApiError(416,'INVALID_RANGE','文件范围无效。');if(!range[1])start=Math.max(0,file.size-Number(range[2]));else{start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}if(start>end||start>=file.size){res.setHeader('Content-Range',`bytes */${file.size}`);throw new ApiError(416,'INVALID_RANGE','文件范围无效。');}status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${file.size}`);}
        audit(store,url.searchParams.get('download')==='1'?'attachment_download':'attachment_preview',file.id,{archiveId:file.archiveId,name:file.name});
        res.writeHead(status,{'Content-Type':file.mime,'Content-Disposition':disposition(file.name,url.searchParams.get('download')!=='1'),'Accept-Ranges':'bytes','Content-Length':end-start+1});res.end(req.method==='HEAD'?undefined:file.content.subarray(start,end+1));return;
      }
      let data;
      if(req.method==='GET'&&route==='/api/auth/session')data={setupRequired:false,user:session.user,csrfToken:session.csrfToken,expiresAt:session.expiresAt};
      else if(req.method==='POST'&&route==='/api/auth/logout'){logout(store,session);res.setHeader('Set-Cookie',sessionCookie('',true));data={loggedOut:true};}
      else if(req.method==='POST'&&route==='/api/auth/password'){data=changePassword(store,body);res.setHeader('Set-Cookie',sessionCookie('',true));}
      else if(req.method==='GET'&&route==='/api/security/users')data=users(store);
      else if(req.method==='POST'&&route==='/api/security/users')data=saveUser(store,null,body);
      else if(req.method==='PATCH'&&/^\/api\/security\/users\/[A-Za-z0-9_-]+$/.test(route))data=saveUser(store,route.split('/')[4],body);
      else if(req.method==='GET'&&route==='/api/security/levels'){requireAdmin();data=levelsList(store);}
      else if(req.method==='POST'&&route==='/api/security/levels')data=saveLevel(store,null,body);
      else if(req.method==='PATCH'&&/^\/api\/security\/levels\/[A-Za-z0-9_-]+$/.test(route))data=saveLevel(store,route.split('/')[4],body);
      else if(req.method==='GET'&&route==='/api/audit-logs')data=logList(store,url.searchParams);
      else if(req.method==='GET'&&['/api/reminders','/api/statistics'].includes(route)){data=analytics(store,url.searchParams);audit(store,route.endsWith('/statistics')?'statistics_view':'reminders_view','',{company:url.searchParams.get('company')||'',days:data.days});}
      else if(attachmentRoute&&req.method==='GET')data=listAttachments(store,attachmentRoute[1]);
      else if(attachmentRoute&&req.method==='POST'){data=addAttachment(store,attachmentRoute[1],url.searchParams.get('filename')||'',binary);if(data.duplicate)audit(store,'attachment_duplicate',data.id,{archiveId:data.archiveId,name:data.name});}
      else if(req.method==='POST'&&route==='/api/excel/imports/preview')data=previewImport(store,binary,url.searchParams.get('filename')||'',{companyId:url.searchParams.get('companyId')||'',group:url.searchParams.get('group')||'',categoryIds:(url.searchParams.get('categoryIds')||'').split(',').filter(Boolean),numberingYear:url.searchParams.get('numberingYear')||''});
      else if(req.method==='POST'&&/^\/api\/excel\/imports\/[A-Za-z0-9_-]+\/commit$/.test(route))data=commitImport(store,route.split('/')[4]);
      else if(req.method==='GET'&&['/api/bootstrap','/api/companies','/api/departments','/api/categories'].includes(route)){
        const master=store.master(),user=session.user,isAdmin=user.role==='admin';master.companies=master.companies.filter(c=>isAdmin||user.companyIds.includes(c.id));master.departments=master.departments.filter(d=>master.companies.some(c=>c.id===d.companyId));master.confidentialityLevels=master.confidentialityLevels.filter(l=>isAdmin||user.levelIds.includes(l.id));
        master.currentUser=user;master.capabilities={manage:isAdmin,write:user.role!=='viewer',download:isAdmin||user.canDownload,export:isAdmin||user.canExport,unclassified:isAdmin||user.canReadUnclassified};
        data=route.endsWith('/companies')?master.companies:route.endsWith('/departments')?master.departments.filter(d=>!url.searchParams.get('companyId')||d.companyId===url.searchParams.get('companyId')):route.endsWith('/categories')?master.categories:master;
      }
      else if(req.method==='PUT'&&route==='/api/master-data')data=store.saveMaster(body);
      else if(req.method==='GET'&&route==='/api/archives'){data=store.list(url.searchParams);audit(store,'archive_search','',{filters:Object.fromEntries(url.searchParams),total:data.total});}
      else if(req.method==='POST'&&route==='/api/archive-drafts')data=store.createDraft(body);
      else if(req.method==='POST'&&route==='/api/migrations/phase2')data=store.importPhase2(body);
      else{
        const match=route.match(/^\/api\/(archives|archive-drafts)\/([A-Za-z0-9_-]+)(?:\/(register|void))?$/);if(!match)throw new ApiError(404,'NOT_FOUND','接口不存在。');const [,resource,id,action]=match;
        if(req.method==='GET'&&resource==='archives'&&!action){data=store.get(id);audit(store,'archive_view',id,{},data);}
        else if(req.method==='PATCH'&&!action)data=store.updateRecord(id,body);
        else if(req.method==='POST'&&action==='register'){const input=parse(versionSchema,body);data=store.register(id,input.recordVersion);}
        else if(req.method==='POST'&&action==='void'){const input=parse(voidSchema,body);data=store.void(id,input.recordVersion,input.reason);}
        else throw new ApiError(405,'METHOD_NOT_ALLOWED','该接口不支持此操作。');
      }
      send(200,{data});
    }catch(error){
      if(res.headersSent){res.end();return;}
      res.setHeader('Content-Type','application/json; charset=utf-8');audit(store,error.status===403||error.status===404?'access_denied':'request_failed',route,{method:req.method,code:error.code||'INTERNAL_ERROR'});
      if(error instanceof ApiError)send(error.status,{error:{code:error.code,message:error.message,...(error.details?{details:error.details}:{})}});
      else if(error.code?.startsWith('ERR_SQLITE')||/constraint|database is locked/i.test(error.message||''))send(409,{error:{code:'DATABASE_CONFLICT',message:'数据冲突或数据库暂忙，请刷新后重试。'}});
      else{console.error(error);send(500,{error:{code:'INTERNAL_ERROR',message:'服务暂时无法处理请求，请稍后重试。'}});}
    }
  }));
  server.requestTimeout=60_000;server.headersTimeout=10_000;server.on('close',()=>store.close());return {server,store};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {server}=createArchiveServer({database:process.env.ARCHIVE_DB_PATH||defaultDB,staticDirectory:process.env.ARCHIVE_STATIC_DIR,trustProxy:process.env.ARCHIVE_TRUST_PROXY==='1',...(process.env.ARCHIVE_ALLOWED_ORIGINS?{allowedOrigins:process.env.ARCHIVE_ALLOWED_ORIGINS.split(',').map(s=>s.trim()).filter(Boolean)}:{})});
  const host=process.env.ARCHIVE_HOST||'127.0.0.1';
  server.listen(Number(process.env.PORT||3001),host,()=>console.log(`Archive API: http://${host}:${server.address().port}`));const stop=()=>server.close(()=>process.exit(0));process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
