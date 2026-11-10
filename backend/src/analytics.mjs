import { ApiError,reject } from './schema.mjs';
import { scopeSQL } from './access.mjs';

export function shanghaiToday(date=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');}
export function analytics(store,query,{today=shanghaiToday()}={}){
  const days=Number(query.get('days')||30);if(![7,30,60,90].includes(days))reject('提醒窗口请选择7、30、60或90天。');
  const company=query.get('company')||'',scope=scopeSQL('a');
  return store.readTransaction(()=>{
    const rows=store.db.prepare(`SELECT a.* FROM archives a WHERE (${scope.sql})${company?' AND company_id=?':''} ORDER BY created_at DESC,rowid DESC`).all(...scope.args,...(company?[company]:[]));
    const master=store.master(),totals={draft:0,registered:0,void:0},groups={document:0,qualification:0},byCompany=new Map(),byCategory=new Map();
    const reminders=[];
    for(const row of rows){const r=JSON.parse(row.data);totals[row.status]++;groups[r.group]++;
      const c=master.companies.find(c=>c.id===r.companyId);byCompany.set(c.id,{id:c.id,name:c.name,count:(byCompany.get(c.id)?.count||0)+1});
      const category=master.categories.find(c=>c.id===r.categoryIds[0]);const key=category?.id||'qualification';byCategory.set(key,{id:key,name:category?.name||'资质类（含证书）',count:(byCategory.get(key)?.count||0)+1});
      if(row.status!=='registered')continue;
      for(const [type,mode,end]of [['validity',r.validityMode,r.validUntil],['retention',r.retentionMode,r.retentionUntil]]){
        if(mode!=='fixed'||!end)continue;const remaining=Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);
        if(remaining<=days)reminders.push({id:row.id,title:r.title,companyId:r.companyId,companyName:c.name,archiveNumber:row.archive_number,type,end,remaining,state:remaining<0?'expired':remaining===0?'today':'soon'});
      }
    }
    reminders.sort((a,b)=>a.remaining-b.remaining||a.id.localeCompare(b.id)||a.type.localeCompare(b.type));
    return {today,timeZone:'Asia/Shanghai',days,total:rows.length,totals,groups,byCompany:[...byCompany.values()].sort((a,b)=>b.count-a.count),byCategory:[...byCategory.values()].sort((a,b)=>b.count-a.count),reminders};
  });
}
