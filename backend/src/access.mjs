import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from './schema.mjs';

export const requestContext=new AsyncLocalStorage();
export const actor=()=>requestContext.getStore()?.user;
export function requireAdmin(){const user=actor();if(user&&user.role!=='admin')throw new ApiError(403,'FORBIDDEN','仅系统管理员可执行此操作。');}
export function requireWrite(){const user=actor();if(user?.role==='viewer')throw new ApiError(403,'FORBIDDEN','查询人员只能查看，不能修改资料。');}
export function requireCapability(key){const user=actor();if(user&&user.role!=='admin'&&!user[key])throw new ApiError(403,'FORBIDDEN',key==='canDownload'?'未获附件原文件访问权限（含预览和下载）。':'未获Excel导出权限。');}
export function canRead(record,user=actor()){
  if(!user||user.role==='admin')return true;
  return user.companyIds.includes(record.companyId)&&(record.confidentialityLevel?user.levelIds.includes(record.confidentialityLevel):user.canReadUnclassified);
}
export function assertRead(record){if(!canRead(record))throw new ApiError(404,'NOT_FOUND','档案不存在或不在授权范围内。');}
export function assertWrite(record){requireWrite();if(!canRead(record))throw new ApiError(403,'FORBIDDEN','公司或秘密等级不在授权范围内。');}
export function scopeSQL(alias='a'){
  const user=actor();if(!user||user.role==='admin')return {sql:'1=1',args:[]};
  const company=user.companyIds.length?`${alias}.company_id IN (${user.companyIds.map(()=>'?').join(',')})`:'0=1';
  const level=`COALESCE(json_extract(${alias}.data,'$.confidentialityLevel'),'')`;
  const parts=[];const args=[...user.companyIds];
  if(user.levelIds.length){parts.push(`${level} IN (${user.levelIds.map(()=>'?').join(',')})`);args.push(...user.levelIds);}
  if(user.canReadUnclassified)parts.push(`${level}=''`);
  return {sql:`(${company}) AND (${parts.length?parts.join(' OR '):'0=1'})`,args};
}
export function audit(store,action,targetId='',detail={},record=null){
  const context=requestContext.getStore();if(!context?.user)return;
  store.db.prepare('INSERT INTO operation_logs(id,user_id,username,action,target_id,company_id,level_id,detail,created_at,request_id,ip) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),context.user.id,context.user.username,action,targetId,record?.companyId||'',record?.confidentialityLevel||'',JSON.stringify(detail),new Date().toISOString(),context.requestId||'',context.ip||'');
}
