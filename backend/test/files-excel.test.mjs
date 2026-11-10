import test from 'node:test';
import { authFetch as fetch } from './auth-helper.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { ArchiveStore } from '../src/store.mjs';
import { createArchiveServer } from '../src/server.mjs';
import { initializeAttachments, addAttachment, listAttachments, attachmentContent } from '../src/attachments.mjs';
import { initializeExcel, COLUMNS, templateWorkbook, previewImport, commitImport, exportWorkbook, importReport } from '../src/excel.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=','base64');
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
const draft=(changes={})=>({id:randomUUID(),companyId:'company-4',group:'qualification',categoryIds:[],title:'文件验收',certificateNumber:'',issuingAuthority:'',issuedOn:'',originalCount:null,copyCount:null,scanCount:3,validityMode:'unknown',validFrom:'',validUntil:'',transferPerson:'',departmentId:'',confidentialityLevel:'',retentionMode:'unknown',retentionFrom:'',retentionUntil:'',storageLocation:'',remarks:'',numberingYear:'',isExample:false,recordVersion:0,...changes});
const input=(changes={})=>({title:'表格验收',companyCode:'GF',group:'资质类（含证书）',...changes});
function fixture(rows,bookType='xlsx') {const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([COLUMNS.map(c=>c[1]),...rows.map(r=>COLUMNS.map(([key])=>r[key]??null))]),'档案导入');return XLSX.write(book,{type:'buffer',bookType});}
function setup(){const store=new ArchiveStore(':memory:');initializeAttachments(store);initializeExcel(store);return store;}
function useStore(fn){const store=setup();try{return fn(store);}finally{store.close();}}
const throwsCode=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('attachments retain original bytes; dedup and file count never overwrite scan copies',()=>useStore(store=>{
  const record=store.createDraft(draft()),file=addAttachment(store,record.id,'中文扫描件.png',PNG);
  assert.equal(file.duplicate,false);assert.equal(file.mime,'image/png');assert.deepEqual(attachmentContent(store,file.id).content,PNG);
  assert.equal(addAttachment(store,record.id,'同一内容.png',PNG).duplicate,true);assert.equal(listAttachments(store,record.id).length,1);
  assert.equal(store.get(record.id).scanCount,3);assert.equal(store.get(record.id).recordVersion,1);
  const second=store.createDraft(draft());assert.equal(addAttachment(store,second.id,'扫描件.png',PNG).duplicate,false);
}));
test('unsupported, path, oversized and void uploads are rejected',()=>useStore(store=>{
  const r=store.createDraft(draft());throwsCode(()=>addAttachment(store,r.id,'../file.png',PNG),'VALIDATION_ERROR');
  throwsCode(()=>addAttachment(store,r.id,'fake.pdf',Buffer.from('<script>bad</script>')),'UNSUPPORTED_ATTACHMENT');
  throwsCode(()=>addAttachment(store,r.id,'file.svg',Buffer.from('<svg/>')),'UNSUPPORTED_ATTACHMENT');
  throwsCode(()=>addAttachment(store,r.id,'large.png',Buffer.alloc(20*1024*1024+1)),'VALIDATION_ERROR');
  const official=store.register(r.id,1);store.void(r.id,official.recordVersion,'测试作废');throwsCode(()=>addAttachment(store,r.id,'file.png',PNG),'ARCHIVE_VOID');
}));
test('template contains all 17 source columns and master-data references without invented records',()=>useStore(store=>{
  const b=XLSX.read(templateWorkbook(store),{type:'buffer'});assert.deepEqual(b.SheetNames,['档案导入','填写说明','公司目录','分类目录']);
  assert.equal(XLSX.utils.sheet_to_json(b.Sheets['档案导入']).length,0);assert.equal(XLSX.utils.sheet_to_json(b.Sheets['公司目录']).length,33);
  assert.equal(COLUMNS.slice(0,17).length,17);assert.equal(b.Sheets['档案导入'].C1.v,'证书编号');
}));
test('preview reports each bad row, preserves zero and leading zero, commits only ready rows idempotently',()=>useStore(store=>{
  const file=fixture([input({certificateNumber:'00123',originalCount:0}),input({title:'负数',originalCount:-1}),input({title:'未知公司',companyCode:'NO'}),input({title:'错误日期',issuedOn:'2026-02-30'}),input({certificateNumber:'00123',originalCount:0})]);
  const preview=previewImport(store,file,'mixed.xlsx');assert.equal(preview.ready,1);assert.equal(preview.failed,3);assert.equal(preview.duplicates,1);assert.equal(store.list(new URLSearchParams()).total,0);
  const result=commitImport(store,preview.id);assert.equal(result.imported,1);assert.equal(result.failed,3);assert.deepEqual(commitImport(store,preview.id),result);
  const record=store.list(new URLSearchParams()).records[0];assert.equal(record.status,'draft');assert.equal(record.archiveNumber,null);assert.equal(record.originalCount,0);assert.equal(record.copyCount,null);assert.equal(record.certificateNumber,'00123');
  assert.equal(previewImport(store,file,'again.xlsx').duplicates,2);
  const report=XLSX.read(importReport(store,preview.id),{type:'buffer'});const rows=XLSX.utils.sheet_to_json(report.Sheets['导入结果']);assert.equal(rows.length,5);assert.equal(rows[1]['导入结果'],'失败');assert.ok(rows[1]['原因与提醒']);
}));
test('real XLS binary and original merged two-row ledger headers can be imported with explicit defaults',()=>useStore(store=>{
  const legacy=fixture([input({certificateNumber:'00001'})],'biff8');assert.equal(previewImport(store,legacy,'legacy.xls').ready,1);
  const top=['序号','证件名称','证书编号','发证单位','数量（份）',null,null,'证件有效时间',null,'证件发证时间','移交人','移交部门','秘密等级','档案保存\n开始日期','档案保存\n终止日期','存放位置','备注'];
  const sub=[null,null,null,null,'原件','复印件','扫描件','开始时间','到期时间'];
  const sheet=XLSX.utils.aoa_to_sheet([['档案台账'],top,sub,[1,'旧版证照','00002','单位',0,null,2,'2026-01-01','2027-01-01','2026-01-01']]);sheet['!merges']=[{s:{r:0,c:0},e:{r:0,c:16}},{s:{r:1,c:4},e:{r:1,c:6}},{s:{r:1,c:7},e:{r:1,c:8}}];
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'原始台账');const bytes=XLSX.write(book,{type:'buffer',bookType:'biff8'});
  const result=previewImport(store,bytes,'original.xls',{companyId:'company-4',group:'qualification'});assert.equal(result.ready,1);commitImport(store,result.id);assert.equal(store.list(new URLSearchParams()).records[0].validUntil,'2027-01-01');
}));
test('formulas are not executed and numeric certificate display formatting preserves leading zero',()=>useStore(store=>{
  const book=XLSX.read(fixture([input({title:'公式'}),input({title:'显示格式',certificateNumber:123}),input({title:'无缓存公式'})]),{type:'buffer'});
  book.Sheets['档案导入'].B2={t:'s',v:'cached',f:'HYPERLINK("https://example.invalid","x")'};book.Sheets['档案导入'].C3.z='00000';
  book.Sheets['档案导入'].E4={t:'n',f:'1+1'};
  const p=previewImport(store,XLSX.write(book,{type:'buffer',bookType:'xlsx'}),'formula.xlsx');assert.equal(p.failed,2);assert.equal(p.ready,1);assert.match(p.rows[0].errors[0],/公式/);assert.match(p.rows[2].errors[0],/公式/);commitImport(store,p.id);assert.equal(store.list(new URLSearchParams()).records[0].certificateNumber,'00123');
}));
test('year defaults apply only to yearly paths; deep paths and real Excel dates round-trip',()=>useStore(store=>{
  const bytes=fixture([input({title:'连续',group:'文书档案类',categoryPath:'01/01'}),input({title:'年份',group:'文书档案类',categoryPath:'20'}),input({title:'更深',group:'文书档案类',categoryPath:'09/01/02'}),input({title:'日期',issuedOn:new Date('2026-11-09T00:00:00Z')})]);
  const p=previewImport(store,bytes,'years.xlsx',{numberingYear:'2026'});assert.equal(p.ready,4,p.rows.map(r=>r.errors).join());commitImport(store,p.id);
  const records=store.list(new URLSearchParams()).records;assert.equal(records.find(r=>r.title==='年份').numberingYear,'2026');assert.equal(records.find(r=>r.title==='连续').numberingYear,'');assert.equal(records.find(r=>r.title==='日期').issuedOn,'2026-11-09');assert.equal(records.find(r=>r.title==='更深').categoryIds.length,3);
}));
test('import commit detects changed master data, concurrent duplicates, expiry and transactional failures',()=>useStore(store=>{
  let p=previewImport(store,fixture([input()]),'x.xlsx');store.saveMaster((({revision,companies,departments,categories})=>({revision,companies,departments,categories}))(store.master()));throwsCode(()=>commitImport(store,p.id),'REVISION_CONFLICT');
  p=previewImport(store,fixture([input({title:'到期'})]),'x.xlsx');store.db.prepare('UPDATE excel_import_jobs SET expires_at=? WHERE id=?').run('2000-01-01',p.id);throwsCode(()=>commitImport(store,p.id),'IMPORT_EXPIRED');
  p=previewImport(store,fixture([input({title:'回滚1'}),input({title:'回滚2'})]),'x.xlsx');store.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON archives WHEN NEW.title='回滚2' BEGIN SELECT RAISE(ABORT,'failure');END");assert.throws(()=>commitImport(store,p.id));assert.equal(store.list(new URLSearchParams()).total,0);store.db.exec('DROP TRIGGER fail_import');assert.equal(commitImport(store,p.id).imported,2);
  const q=previewImport(store,fixture([input({title:'并发重复'})]),'x.xlsx');const other=previewImport(store,fixture([input({title:'并发重复'})]),'x.xlsx');commitImport(store,other.id);assert.equal(commitImport(store,q.id).duplicates,1);
}));
test('export includes all filtered pages, original fields, lifecycle, attachment count, and literal strings',()=>useStore(store=>{
  for(let i=0;i<12;i++)store.createDraft(draft({title:'导出'+i,certificateNumber:'00'+i}));
  const special=store.createDraft(draft({title:'=HYPERLINK("literal")',certificateNumber:'00000',originalCount:0,scanCount:9,issuedOn:'2026-11-09'}));addAttachment(store,special.id,'扫描.png',PNG);
  const book=XLSX.read(exportWorkbook(store,new URLSearchParams('page=2&pageSize=1')),{type:'buffer',cellDates:true}),sheet=book.Sheets['档案台账'],rows=XLSX.utils.sheet_to_json(sheet,{defval:null});assert.equal(rows.length,13);
  const row=rows.find(r=>r['证书编号']==='00000');assert.equal(row['原件数量（份）'],0);assert.equal(row['扫描件数量（份）'],9);assert.equal(row['附件文件数'],1);assert.equal(row['复印件数量（份）'],null);assert.equal(row['证件发证日期'].toISOString().slice(0,10),'2026-11-09');
  const titleCell=Object.values(sheet).find(cell=>cell?.v==='=HYPERLINK("literal")');assert.equal(titleCell.t,'s');assert.equal(titleCell.f,undefined);
  const filtered=XLSX.read(exportWorkbook(store,new URLSearchParams('keyword=00000')),{type:'buffer'});assert.equal(XLSX.utils.sheet_to_json(filtered.Sheets['档案台账']).length,1);
}));
test('bad, empty, oversized-row workbooks and export records cannot silently create duplicates',()=>useStore(store=>{
  throwsCode(()=>previewImport(store,Buffer.from('not excel'),'bad.xlsx'),'VALIDATION_ERROR');
  throwsCode(()=>previewImport(store,templateWorkbook(store),'empty.xlsx'),'EMPTY_WORKBOOK');
  throwsCode(()=>previewImport(store,fixture(Array.from({length:1001},(_,i)=>input({title:String(i)}))),'many.xlsx'),'VALIDATION_ERROR');
  const r=store.createDraft(draft());store.register(r.id,1);const p=previewImport(store,exportWorkbook(store,new URLSearchParams()),'export.xlsx');assert.equal(p.failed,1);assert.match(p.rows[0].errors.join(),/档号|档案ID/);
}));
test('HTTP attachment streams, ranges, Unicode filename, template, preview, commit, report and export work',async()=>{
  const {server,store}=createArchiveServer({database:':memory:'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const r=store.createDraft(draft());const response=await fetch(base+`/api/archives/${r.id}/attachments?filename=${encodeURIComponent('扫描.pdf')}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:PDF});const file=(await response.json()).data;assert.equal(response.status,200);
    const get=await fetch(base+`/api/attachments/${file.id}/content`);assert.equal(get.headers.get('content-type'),'application/pdf');assert.match(get.headers.get('content-disposition'),/filename\*=UTF-8/);assert.deepEqual(Buffer.from(await get.arrayBuffer()),PDF);
    const range=await fetch(base+`/api/attachments/${file.id}/content`,{headers:{Range:'bytes=0-4'}});assert.equal(range.status,206);assert.equal(await range.text(),'%PDF-');assert.equal((await fetch(base+`/api/attachments/${file.id}/content`,{headers:{Range:'bytes=9999-'}})).status,416);
    assert.equal((await fetch(base+`/api/attachments/${file.id}/content`,{method:'HEAD'})).headers.get('content-length'),String(PDF.length));
    assert.equal((await fetch(base+'/api/excel/template')).status,200);
    const preview=await fetch(base+'/api/excel/imports/preview?filename=batch.xlsx',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:fixture([input({title:'HTTP导入'})])}).then(r=>r.json());assert.equal(preview.data.ready,1);
    const commit=await fetch(base+`/api/excel/imports/${preview.data.id}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json());assert.equal(commit.data.imported,1);
    assert.equal((await fetch(base+`/api/excel/imports/${preview.data.id}/report`)).status,200);assert.equal((await fetch(base+'/api/excel/export?keyword=HTTP')).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
