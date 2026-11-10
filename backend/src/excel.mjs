import * as XLSX from 'xlsx';
import { randomUUID, createHash } from 'node:crypto';
import { ApiError, reject, parse, editableSchema, validateRecord, findPath } from './schema.mjs';
import { actor,scopeSQL,assertWrite,assertRead,requireWrite,requireCapability,audit } from './access.mjs';

export const MAX_EXCEL_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 1000, MAX_EXPORT = 20000;
// The first 17 columns map one-to-one to the supplied ledger's A:Q fields.
export const COLUMNS = [
  ['sequence','序号'],['title','证件名称'],['certificateNumber','证书编号'],['issuingAuthority','发证单位'],
  ['originalCount','原件数量（份）'],['copyCount','复印件数量（份）'],['scanCount','扫描件数量（份）'],
  ['validFrom','证件有效开始日期'],['validUntil','证件有效到期日期'],['issuedOn','证件发证日期'],
  ['transferPerson','移交人'],['departmentName','移交部门'],['confidentiality','秘密等级'],
  ['retentionFrom','档案保存开始日期'],['retentionUntil','档案保存终止日期'],['storageLocation','存放位置'],['remarks','备注'],
  ['companyCode','公司编码'],['companyName','所属公司'],['group','档案大类'],['categoryPath','分类编码路径'],['numberingYear','归档年份'],
  ['validityMode','有效期类型'],['retentionMode','保存期限类型'],
];
const OUTPUT_COLUMNS = [...COLUMNS,['archiveNumber','档号'],['status','登记状态'],['id','档案ID'],['attachmentCount','附件文件数']];
const aliases = { '档案名称':'title','公司名称':'companyName','类别':'group','原件':'originalCount','复印件':'copyCount','扫描件':'scanCount','证件发证时间':'issuedOn','发证日期':'issuedOn','有效开始日期':'validFrom','有效到期日期':'validUntil','编号年份':'numberingYear' };
const norm = value => String(value ?? '').replace(/[\s（）():：]/g,'');
const headerMap = new Map([...COLUMNS,...OUTPUT_COLUMNS].map(([key,label])=>[norm(label),key]));
Object.entries(aliases).forEach(([label,key])=>headerMap.set(norm(label),key));
const meaningfulKeys = Object.keys(editableSchema.shape).filter(k=>!['id','recordVersion'].includes(k));
function recordHash(record) { return createHash('sha256').update(JSON.stringify(meaningfulKeys.map(key=>record[key]))).digest('hex'); }
function existingHashes(store) { const scope=scopeSQL('a');return new Set(store.db.prepare(`SELECT data FROM archives a WHERE ${scope.sql}`).all(...scope.args).map(row=>recordHash(JSON.parse(row.data)))); }

export function initializeExcel(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS excel_import_jobs(id TEXT PRIMARY KEY,master_revision INTEGER NOT NULL,rows_json TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS archives_certificate_number ON archives(certificate_number);
    UPDATE metadata SET value='2' WHERE key='schema_version';`);
  if(!store.db.prepare('PRAGMA table_info(excel_import_jobs)').all().some(c=>c.name==='owner_id'))store.db.exec("ALTER TABLE excel_import_jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
}
function workbook(rows, name = '档案台账', columns = OUTPUT_COLUMNS) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([columns.map(c=>c[1]),...rows.map(r=>columns.map(([key])=>r[key] ?? null))],{cellDates:true,dateNF:'yyyy-mm-dd'});
  sheet['!cols'] = columns.map(([key])=>({wch: ['title','companyName','remarks','categoryPath','storageLocation'].includes(key)?32:18}));
  sheet['!autofilter'] = {ref:sheet['!ref'] || 'A1:A1'};
  XLSX.utils.book_append_sheet(book,sheet,name); return book;
}
function bytes(book) { return XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true,cellDates:true}); }
export function templateWorkbook(store) {
  requireWrite();
  const master=store.master(), book=workbook([],'档案导入',COLUMNS);
  const user=actor();if(user&&user.role!=='admin')master.companies=master.companies.filter(c=>user.companyIds.includes(c.id));
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
    ['填写事项','规则'],['导入方式','先预览，确认后仅将可用行保存为草稿；不自动正式入账。'],
    ['所属公司','填写公司编码或公司全称；也可在上传界面选择缺省公司。'],['档案大类','填写资质类（含证书）或文书档案类。'],
    ['分类编码路径','文书类填写完整路径，例如01/01；更深分类09/01/02；直接编号类别02。'],
    ['归档年份','技术04、合同20、收文23、发文24按年编号，应填写四位归档年份。'],
    ['数量','原件、复印件、扫描件分别填非负整数；空白为待核实，0为没有；不等于附件文件数。'],
    ['编号与日期','证书编号请使用文本以保留前导零，日期使用YYYY-MM-DD。不要使用公式。'],
    ['有效期类型','有期限、长期有效、不适用、待核实；有期限必须填写到期日期。'],
    ['保存期限类型','有期限、长期保存、待核实；有期限必须填写保存终止日期。'],
    ['秘密等级','填写已配置且已获授权的等级名称；留空/待核定须有未定密访问授权。'],
    ['现有记录','导出中的正式档号/档案ID用于查询，不支持通过导入覆盖已有记录。'],
    ['容量','单文件最大10MB、最多1000行数据；支持.xls和.xlsx。'],
  ]),'填写说明');
  const companies=XLSX.utils.aoa_to_sheet([['公司编码','公司全称','简称','状态','文书目录'],...master.companies.map(c=>[c.code,c.name,c.shortName,c.enabled?'启用':'停用',c.categoryEnabled?'已启用':'待确认'])]);companies['!cols']=[{wch:16},{wch:65},{wch:22},{wch:12},{wch:14}];XLSX.utils.book_append_sheet(book,companies,'公司目录');
  const paths=[]; const walk=(nodes,codes=[],names=[])=>{for(const n of nodes){paths.push([[...codes,n.code].join('/'),[...names,n.name].join('/'),n.mode==='year'?'按归档年份编号':n.mode==='unresolved'?'细则待明确':'连续编号',n.enabled?'启用':'停用']);walk(n.children,[...codes,n.code],[...names,n.name]);}};walk(master.categories);
  const classes=XLSX.utils.aoa_to_sheet([['分类编码路径','分类名称路径','编号规则','状态'],...paths]);classes['!cols']=[{wch:22},{wch:75},{wch:22},{wch:12}];XLSX.utils.book_append_sheet(book,classes,'分类目录');return bytes(book);
}
export function exportWorkbook(store, query) {
  requireCapability('canExport');
  let count=0;const output=store.readTransaction(()=>{
    const params=new URLSearchParams(query);params.set('page','1');params.set('pageSize','100');
    let result=store.list(params);if(result.total>MAX_EXPORT)reject('导出超过20000条，请缩小查询范围。');
    const records=[...result.records];for(let p=2;p<=Math.ceil(result.total/100);p++){params.set('page',String(p));records.push(...store.list(params).records);}
    const master=store.master();
    const rows=records.map((r,i)=>{
      const company=master.companies.find(c=>c.id===r.companyId), path=findPath(master.categories,r.categoryIds);
      const dates=Object.fromEntries(['issuedOn','validFrom','validUntil','retentionFrom','retentionUntil'].map(key=>[key,r[key]?new Date(r[key]+'T00:00:00Z'):null]));
      return {...r,...dates,sequence:i+1,companyCode:company.code,companyName:company.name,group:r.group==='document'?'文书档案类':'资质类（含证书）',categoryPath:path.map(c=>c.code).join('/'),departmentName:master.departments.find(d=>d.id===r.departmentId)?.name||'',confidentiality:master.confidentialityLevels.find(l=>l.id===r.confidentialityLevel)?.name||'待核定',validityMode:({fixed:'有期限',permanent:'长期有效',na:'不适用',unknown:'待核实'})[r.validityMode],retentionMode:({fixed:'有期限',permanent:'长期保存',unknown:'待核实'})[r.retentionMode],status:({draft:'草稿',registered:'已登记',void:'已作废'})[r.status],attachmentCount:Number(store.db.prepare('SELECT count(*) AS n FROM attachments WHERE archive_id=?').get(r.id).n)};
    });count=rows.length;return bytes(workbook(rows));
  });
  audit(store,'excel_export','',{count,filters:Object.fromEntries(query)});return output;
}
function value(cell, kind='text', date1904=false) {
  if (cell?.f) throw new Error('包含公式，请复制并粘贴为值后导入。');
  if (!cell || cell.v===null || cell.v===undefined || cell.v==='') return '';
  if (kind==='date') {
    if (cell.v instanceof Date) return cell.v.toISOString().slice(0,10);
    if (typeof cell.v==='number') {const d=XLSX.SSF.parse_date_code(cell.v,{date1904});if(!d)throw new Error('日期数值无效。');return `${String(d.y).padStart(4,'0')}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}
    const text=String(cell.v).trim();const match=text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);if(match)return `${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;return text;
  }
  if (kind==='certificate' && typeof cell.v==='number')return cell.w||String(cell.v);
  return typeof cell.v==='number'?cell.v:String(cell.v).trim();
}
function locateSheet(book) {
  const names=[...new Set(['档案导入','档案台账',...book.SheetNames])];
  for(const name of names){const sheet=book.Sheets[name];if(!sheet?.['!ref'])continue;const range=XLSX.utils.decode_range(sheet['!ref']);
    for(let r=0;r<=Math.min(9,range.e.r);r++){
      for(let c=0;c<=Math.min(80,range.e.c);c++)if(['证件名称','档案名称'].includes(norm(sheet[XLSX.utils.encode_cell({r,c})]?.v))){
        if(range.e.c>80)reject('工作表列数过多，请使用系统模板。');
        const next=Array.from({length:Math.min(81,range.e.c+1)},(_,i)=>norm(sheet[XLSX.utils.encode_cell({r:r+1,c:i})]?.v));
        const double=next.includes('原件')&&next.includes('复印件');
        const mapping=new Map();
        for(let col=0;col<=range.e.c;col++){
          let top=sheet[XLSX.utils.encode_cell({r,c:col})]?.v;
          if(!top){const merged=(sheet['!merges']||[]).find(m=>m.s.r<=r&&m.e.r>=r&&m.s.c<=col&&m.e.c>=col);if(merged)top=sheet[XLSX.utils.encode_cell(merged.s)]?.v;}
          const child=double?sheet[XLSX.utils.encode_cell({r:r+1,c:col})]?.v:'';
          let key=headerMap.get(norm(top));
          if(double&&norm(top).startsWith('数量'))key=headerMap.get(norm(child));
          if(double&&norm(top)==='证件有效时间')key=norm(child)==='开始时间'?'validFrom':norm(child)==='到期时间'?'validUntil':undefined;
          if(key){if(mapping.has(key))reject(`工作表存在重复列：${top}`);mapping.set(key,col);}
        }
        return {sheet,name,mapping,start:r+(double?2:1),range};
      }
    }
  }reject('未找到“证件名称”或“档案名称”表头，请使用系统模板。','HEADER_NOT_FOUND');
}
function createFromRow(raw, defaults, master, warnings) {
  const companyCode=String(raw.companyCode||'').trim(), companyName=String(raw.companyName||'').trim();
  const byCode=companyCode?master.companies.find(c=>c.code===companyCode):null, byName=companyName?master.companies.find(c=>c.name===companyName):null;
  if(companyCode&&!byCode)throw new Error('公司编码未匹配到已有公司。');if(companyName&&!byName)throw new Error('公司全称未匹配到已有公司。');if(byCode&&byName&&byCode.id!==byName.id)throw new Error('公司编码和公司名称指向不同公司。');
  const company=byCode||byName||master.companies.find(c=>c.id===defaults.companyId);if(!company)throw new Error('缺少所属公司，请填写公司编码/全称或选择缺省公司。');
  const groupText=String(raw.group||defaults.group||''), group=({'文书档案类':'document','文书':'document','资质类含证书':'qualification','资质类':'qualification','资质':'qualification',document:'document',qualification:'qualification'})[norm(groupText)];if(!group)throw new Error('档案大类必须为资质类（含证书）或文书档案类。');
  let nodes=master.categories, categoryIds=[];
  if(group==='document'){
    if(raw.categoryPath){const codes=String(raw.categoryPath).split(/[\/-]/).map(s=>s.trim());for(const code of codes){const node=nodes.find(n=>n.code===code);if(!node)throw new Error(`分类编码路径不存在：${raw.categoryPath}`);categoryIds.push(node.id);nodes=node.children;}}
    else categoryIds=defaults.categoryIds||[];
  } else if(raw.categoryPath)throw new Error('资质类不使用文书分类编码路径。');
  if(raw.archiveNumber||raw.id)throw new Error('含已有档号或档案ID，不能通过新增导入覆盖；请在系统中编辑。');
  if(raw.status&&raw.status!=='草稿')throw new Error('不能通过导入指定正式登记或作废状态。');
  const getCount=key=>{const v=raw[key];if(v===''||v===undefined||['待核实','—','-'].includes(String(v)))return null;if(!/^[0-9]+$/.test(String(v)))throw new Error(`${COLUMNS.find(c=>c[0]===key)[1]}必须为非负整数。`);return Number(v);};
  const mode=(v,options,fallback)=>{if(!v)return fallback;const result=options[String(v)];if(!result)throw new Error(`期限类型无法识别：${v}`);return result;};
  let validUntil=String(raw.validUntil||''), retentionUntil=String(raw.retentionUntil||'');
  const validLong=['长期','长期有效','永久'].includes(validUntil), retainLong=['长期','长期保存','永久'].includes(retentionUntil);
  const validityMode=mode(raw.validityMode,{'有期限':'fixed','长期有效':'permanent','不适用':'na','待核实':'unknown'},validLong?'permanent':validUntil?'fixed':group==='document'?'na':'unknown');
  const retentionMode=mode(raw.retentionMode,{'有期限':'fixed','长期保存':'permanent','待核实':'unknown'},retainLong?'permanent':retentionUntil?'fixed':'unknown');
  if(validLong)validUntil='';if(retainLong)retentionUntil='';
  let confidentialityLevel='';if(raw.confidentiality&&!['待核定','待补','待核定（字典待补）'].includes(String(raw.confidentiality))){const level=master.confidentialityLevels.find(l=>l.name===String(raw.confidentiality)&&l.enabled);if(!level)throw new Error('秘密等级不存在或已停用。');confidentialityLevel=level.id;}
  let departmentId='';if(raw.departmentName){const department=master.departments.find(d=>d.companyId===company.id&&d.name===String(raw.departmentName));if(!department)throw new Error('移交部门不在该公司目录中，请先维护部门。');departmentId=department.id;}
  const yearly=group==='document'&&findPath(master.categories,categoryIds)[0]?.mode==='year';
  const record={id:randomUUID(),companyId:company.id,group,categoryIds,title:String(raw.title||''),certificateNumber:String(raw.certificateNumber||''),issuingAuthority:String(raw.issuingAuthority||''),issuedOn:String(raw.issuedOn||''),originalCount:getCount('originalCount'),copyCount:getCount('copyCount'),scanCount:getCount('scanCount'),validityMode,validFrom:String(raw.validFrom||''),validUntil,transferPerson:String(raw.transferPerson||''),departmentId,confidentialityLevel:'',retentionMode,retentionFrom:String(raw.retentionFrom||''),retentionUntil,storageLocation:String(raw.storageLocation||''),remarks:String(raw.remarks||''),numberingYear:String(raw.numberingYear||(yearly?defaults.numberingYear:'')||''),isExample:false,recordVersion:0};
  if(!company.code)warnings.push('公司编码待补：可导入草稿，不能正式入账。');
  const path=findPath(master.categories,categoryIds);if(path[0]?.mode==='unresolved')warnings.push('分类细则待明确：可导入草稿，不能正式入账。');
  record.confidentialityLevel=confidentialityLevel;return record;
}
export function previewImport(store, content, name, defaults={}) {
  requireWrite();
  const data=Buffer.from(content);if(!data.length||data.length>MAX_EXCEL_SIZE)reject('Excel不能为空，最大10MB。');
  const ext=name?.toLowerCase().match(/\.(xls|xlsx)$/)?.[1];if(!ext||!(ext==='xlsx'?data.subarray(0,2).toString()==='PK':data.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]))))reject('请选择真实的.xls或.xlsx工作簿。');
  let book;try{book=XLSX.read(data,{type:'buffer',cellDates:true,sheetRows:MAX_ROWS+20,cellFormula:true});}catch{reject('无法读取工作簿，请检查是否损坏或受密码保护。');}
  const located=locateSheet(book),{sheet,mapping,start,range}=located;
  if(range.e.c>80)reject('工作表列数过多，请使用系统模板。');
  if(sheet['!fullref']&&XLSX.utils.decode_range(sheet['!fullref']).e.r>MAX_ROWS+19)reject('工作表超过读取范围，请将文件拆分为最多1000行，并删除多余空白格式行。');
  return store.transaction(()=>{
    const master=store.master(),hashes=existingHashes(store),rows=[];
    const user=actor();if(user&&user.role!=='admin'){master.companies=master.companies.filter(c=>user.companyIds.includes(c.id));master.confidentialityLevels=master.confidentialityLevels.filter(l=>user.levelIds.includes(l.id));}
    for(let r=start;r<=range.e.r;r++){
      const raw={},errors=[],warnings=[];let any=false;
      for(const [key,c] of mapping){const cell=sheet[XLSX.utils.encode_cell({r,c})];if(cell?.v!==undefined&&cell.v!=='')any=true;try{raw[key]=value(cell,['issuedOn','validFrom','validUntil','retentionFrom','retentionUntil'].includes(key)?'date':key==='certificateNumber'?'certificate':'text',!!book.Workbook?.WBProps?.date1904);if(key==='certificateNumber'&&typeof cell?.v==='number')warnings.push('证书编号为数字，已按显示值读取，请核实前导零。');}catch(e){errors.push(`${COLUMNS.find(c=>c[0]===key)?.[1]||key}：${e.message}`);}}
      if(!any)continue;if(!raw.title&&String(raw.sequence||'').startsWith('说明'))continue;
      if(rows.length>=MAX_ROWS)reject('每次最多导入1000行，请拆分文件。');
      const row={row:r+1,title:String(raw.title||''),status:'ready',errors,warnings,raw,record:null};
      if(!errors.length)try{
        const record=parse(editableSchema,createFromRow(raw,defaults,master,warnings));assertWrite(record);validateRecord(record,master);
        row.record=record;const hash=recordHash(record);if(hashes.has(hash)){row.status='duplicate';warnings.push('与数据库或本文件前面的记录完全重复，跳过。');}else hashes.add(hash);
        const scope=scopeSQL('a');if(record.certificateNumber&&store.db.prepare(`SELECT 1 FROM archives a WHERE certificate_number=? AND status!='void' AND (${scope.sql})`).get(record.certificateNumber,...scope.args))warnings.push('存在相同证书编号，请核查版本。');
      }catch(e){errors.push(e.details?.map(d=>`${d.field}：${d.message}`).join('；')||e.message);}
      if(errors.length)row.status='error';rows.push(row);
    }
    if(!rows.length)reject('文件只有表头、说明或空白，没有可导入的档案数据。','EMPTY_WORKBOOK');
    const id=randomUUID(),created=new Date(),expires=new Date(created.getTime()+30*60*1000);
    store.db.prepare('INSERT INTO excel_import_jobs(id,master_revision,rows_json,result_json,created_at,expires_at,owner_id) VALUES(?,?,?,NULL,?,?,?)').run(id,master.revision,JSON.stringify(rows),created.toISOString(),expires.toISOString(),actor()?.id||'');
    audit(store,'excel_preview',id,{total:rows.length});
    return summarizeJob(id,rows,false);
  });
}
function summarizeJob(id,rows,committed){return {id,committed,total:rows.length,ready:rows.filter(r=>r.status==='ready').length,imported:rows.filter(r=>r.status==='imported').length,duplicates:rows.filter(r=>r.status==='duplicate').length,failed:rows.filter(r=>r.status==='error').length,rows:rows.map(({record,raw,...row})=>row)};}
function job(store,id){const row=store.db.prepare('SELECT * FROM excel_import_jobs WHERE id=?').get(id);if(!row||actor()&&(actor().role!=='admin'&&row.owner_id!==actor().id))throw new ApiError(404,'NOT_FOUND','导入任务不存在或无权访问。');for(const item of JSON.parse(row.rows_json))if(item.record)assertRead(item.record);return row;}
export function commitImport(store,id){
  requireWrite();
  return store.transaction(()=>{
    const task=job(store,id);if(task.result_json)return JSON.parse(task.result_json);
    if(task.expires_at<new Date().toISOString())reject('预览已过期，请重新上传。','IMPORT_EXPIRED',409);
    const master=store.master();if(master.revision!==task.master_revision)reject('基础资料已变化，请重新预览后导入。','REVISION_CONFLICT',409);
    const rows=JSON.parse(task.rows_json),hashes=existingHashes(store);
    for(const row of rows)if(row.status==='ready'){
      validateRecord(row.record,master);const hash=recordHash(row.record);
      if(hashes.has(hash)){row.status='duplicate';row.warnings.push('预览后出现完全相同记录，已跳过。');continue;}
      store.insertDraft(row.record);hashes.add(hash);row.status='imported';
    }
    const result=summarizeJob(id,rows,true);store.db.prepare('UPDATE excel_import_jobs SET rows_json=?,result_json=? WHERE id=?').run(JSON.stringify(rows),JSON.stringify(result),id);audit(store,'excel_import',id,{imported:result.imported,failed:result.failed,duplicates:result.duplicates});return result;
  });
}
export function importReport(store,id){
  requireCapability('canExport');
  const task=job(store,id),rows=JSON.parse(task.rows_json).map(row=>({...row.raw,excelRow:row.row,result:({ready:'可导入',imported:'已导入草稿',duplicate:'重复跳过',error:'失败'})[row.status],reason:[...row.errors,...row.warnings].join('；')}));
  return bytes(workbook(rows,'导入结果',[['excelRow','Excel行号'],['result','导入结果'],['reason','原因与提醒'],...COLUMNS]));
}
