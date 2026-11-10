'use client';
import { useEffect, useState } from 'react';
import { Archive, Files, Bell, ChartNoAxesCombined, Building2, FolderTree, ShieldCheck, ChevronRight, CheckCircle2,ScrollText } from 'lucide-react';
import { type Workspace, type ArchiveRecord, createDraft,roleLabels } from './model';
import { archiveRepository, fileRepository,securityRepository, type ArchivePage, type ArchiveQuery } from './repository';
import { Modal } from './ui';
import RecordForm from './RecordForm';
import RecordDetail from './RecordDetail';
import CompanyAdmin from './CompanyAdmin';
import CategoryAdmin from './CategoryAdmin';
import Ledger from './Ledger';
import ExcelImport from './ExcelImport';
import SecurityAdmin from './SecurityAdmin';
import AnalyticsView from './AnalyticsView';
import AuditView from './AuditView';

export type Filters = Omit<ArchiveQuery, 'page' | 'pageSize'>;
export const emptyFilters: Filters = { company: '', group: '', keyword: '', category: '', department: '', validity: '', status: '' };
type View = 'ledger' | 'companies' | 'categories' | 'form'|'security'|'reminders'|'statistics'|'audit';

export default function ArchiveApp() {
  const [state, setState] = useState<Workspace | null>(null);
  const [fatal, setFatal] = useState('');
  const [view, setView] = useState<View>('ledger');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState<ArchivePage | null>(null);
  const [loading, setLoading] = useState(false), [listError, setListError] = useState('');
  const [reload, setReload] = useState(0);
  const [record, setRecord] = useState<ArchiveRecord | null>(null);
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState<ArchiveRecord | null>(null);
  const [voidTarget, setVoidTarget] = useState<ArchiveRecord | null>(null), [voidReason, setVoidReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [importOpen,setImportOpen]=useState(false);
  const [passwordOpen,setPasswordOpen]=useState(false),[oldPassword,setOldPassword]=useState(''),[newPassword,setNewPassword]=useState(''),[confirmPassword,setConfirmPassword]=useState(''),[passwordError,setPasswordError]=useState('');
  const [localCount, setLocalCount] = useState(0);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  useEffect(() => {
    archiveRepository.load().then(setState).catch(e => setFatal(e.message));
    try { setLocalCount(archiveRepository.localDraftCount()); }
    catch { setNotice({ message: '第二阶段本机资料暂时无法读取，原数据已保留；数据库工作区可正常使用。', error: true }); }
  }, []);
  const revision = state?.revision;
  useEffect(() => {
    if (!revision || view !== 'ledger') return;
    const controller = new AbortController(); setLoading(true); setListError(''); setData(null);
    archiveRepository.list({ ...filters, page, pageSize }, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        if (page > 1 && !result.records.length && result.total > 0) setPage(Math.ceil(result.total / pageSize));
        else { setData(result); setState(current => current ? { ...current, records: result.records } : current); }
      }
    }).catch(e => { if (!controller.signal.aborted) setListError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, filters, page, pageSize, reload, view]);

  const fail = (error: unknown) => setNotice({ message: error instanceof Error ? error.message : '操作失败，请重试。', error: true });
  async function saveMaster(next: Workspace, message: string): Promise<boolean> {
    setSaving(true);
    try { const saved = await archiveRepository.saveMaster(next); setState(current => ({ ...saved, records: current?.records || [] })); setNotice({ message: message.replaceAll('到本机', '到数据库'), error: false }); return true; }
    catch (e) { fail(e); return false; } finally { setSaving(false); }
  }
  function changeFilters(patch: Partial<Filters>) { setFilters(f => ({ ...f, ...patch })); setPage(1); }
  function openNew() {
    const company = state?.companies.find(c => c.id === filters.company && c.enabled) || state?.companies.find(c => c.enabled);
    if (!company) return fail(new Error('请先新增或启用一家公司。'));
    setRecord(createDraft(company.id, filters.group === 'qualification' ? 'qualification' : 'document')); setEditing(false); setView('form');
  }
  async function openDetail(item: ArchiveRecord) {
    setSaving(true); try { setDetail(await archiveRepository.detail(item.id)); } catch (e) { fail(e); } finally { setSaving(false); }
  }
  async function openEdit(item: ArchiveRecord) {
    setSaving(true);
    try {
      const latest = await archiveRepository.detail(item.id);
      if (latest.status === 'void') return fail(new Error('作废档案只读。'));
      setRecord(latest); setEditing(true); setDetail(null); setView('form');
    } catch (e) { fail(e); } finally { setSaving(false); }
  }
  async function saveRecord(item: ArchiveRecord, register = false) {
    setSaving(true);
    let persisted: ArchiveRecord | null = null;
    try {
      let saved = await archiveRepository.saveRecord(item);
      persisted = saved;
      setRecord(saved); // A failed registration must retain the server draft ID/version.
      setFilters({ ...emptyFilters, company: saved.companyId, group: saved.group }); setPage(1);
      if (register) saved = await archiveRepository.register(saved);
      setNotice({ message: `${saved.archiveNumber ? `已保存，档号：${saved.archiveNumber}。` : '草稿已保存到数据库。'}${saved.warnings.join('；')}`, error: false });
      setFilters({ ...emptyFilters, company: saved.companyId, group: saved.group }); setPage(1); setReload(n => n + 1); setRecord(null); setView('ledger'); return true;
    } catch (e) { fail(new Error(`${persisted && register ? '草稿已保存，但未能正式入账：' : ''}${e instanceof Error ? e.message : '操作失败。'}`)); return false; } finally { setSaving(false); }
  }
  async function registerRecord(item: ArchiveRecord) {
    if (!window.confirm(`确认将“${item.title}”正式入账并分配档号？`)) return;
    setSaving(true);
    try { const saved = await archiveRepository.register(item); setNotice({ message: `正式入账成功，档号：${saved.archiveNumber}`, error: false }); setReload(n => n + 1); setDetail(null); }
    catch (e) { fail(e); } finally { setSaving(false); }
  }
  async function voidRecord() {
    if (!voidTarget || !voidReason.trim()) return fail(new Error('请填写作废原因。'));
    setSaving(true);
    try { await archiveRepository.void(voidTarget, voidReason.trim()); setNotice({ message: '档案已作废，档号和记录继续保留。', error: false }); setVoidTarget(null); setDetail(null); setReload(n => n + 1); }
    catch (e) { fail(e); } finally { setSaving(false); }
  }
  async function migrate() {
    if (!window.confirm('将第二阶段本机草稿迁移到数据库？演示数据会跳过，本机原始资料继续保留。')) return;
    setSaving(true);
    try {
      const result = await archiveRepository.migrateLocal(); setState(await archiveRepository.load());
      setNotice({ message: `迁移完成：新增${result.imported}条，已迁移跳过${result.skipped}条，排除演示数据${result.excludedExamples}条。本机原数据保留。`, error: false });
      setReload(n => n + 1);
    } catch (e) { fail(e); } finally { setSaving(false); }
  }
  function navigate(next: View) { if (view !== 'form' || window.confirm('表单尚未保存，确定离开吗？')) { setView(next); setNotice(null); } }
  async function refreshMaster(){setState(await archiveRepository.load());setReload(n=>n+1);}
  async function openReminder(id:string){setSaving(true);try{setDetail(await archiveRepository.detail(id));}catch(e){fail(e);}finally{setSaving(false);}}
  async function exportExcel(){setSaving(true);try{const params=new URLSearchParams();Object.entries(filters).forEach(([key,value])=>{if(value)params.set(key,value);});await fileRepository.download(`/excel/export?${params}`,'档案台账.xlsx');setNotice({message:'已按当前查询条件导出全部匹配记录。',error:false});}catch(e){fail(e);}finally{setSaving(false);}}
  if (fatal) return <div className="startup"><Archive size={30}/><h1>暂时无法连接档案服务</h1><p role="alert">{fatal}</p><button className="button" onClick={() => window.location.reload()}>重新连接</button></div>;
  if (!state) return <div className="startup" role="status"><Archive size={30}/><h1>正在连接档案数据库…</h1></div>;
  const sectionName = view === 'companies' ? '公司与部门' : view === 'categories' ? '分类与编码' : view === 'form' ? editing ? '编辑档案' : '新增档案' : view==='security'?'权限管理':view==='reminders'?'到期提醒':view==='statistics'?'统计汇总':view==='audit'?'操作日志':'档案台账';
  return <div className="app-shell">
    <aside className="sidebar"><button className="brand brand-button" onClick={() => navigate('ledger')} aria-label="档案台账首页"><span className="brand-mark"><Archive size={24}/></span><div><strong>万盛档案</strong><span>档案台账管理系统</span></div></button><div className="nav-label">日常管理</div><nav aria-label="主导航">
      <button className={view === 'ledger' || view === 'form' ? 'selected' : ''} onClick={() => navigate('ledger')}><Files size={19}/>档案台账</button>
      <button className={view==='reminders'?'selected':''} onClick={()=>navigate('reminders')}><Bell size={19}/>到期提醒</button><button className={view==='statistics'?'selected':''} onClick={()=>navigate('statistics')}><ChartNoAxesCombined size={19}/>统计汇总</button>{state.capabilities.manage&&<><div className="nav-label">基础设置</div>
      <button className={view === 'companies' ? 'selected' : ''} onClick={() => navigate('companies')}><Building2 size={19}/>公司与部门</button><button className={view === 'categories' ? 'selected' : ''} onClick={() => navigate('categories')}><FolderTree size={19}/>分类与编码</button><button className={view==='security'?'selected':''} onClick={()=>navigate('security')}><ShieldCheck size={19}/>权限管理</button><button className={view==='audit'?'selected':''} onClick={()=>navigate('audit')}><ScrollText size={19}/>操作日志</button></>}
    </nav><div className="sidebar-foot"><span className="local-dot"/><div><strong>{state.currentUser?roleLabels[state.currentUser.role]:'数据库已连接'}</strong><small>档案台账 · V1.0</small></div></div></aside>
    <div className="app-content"><header className="topbar"><div className="breadcrumb">档案管理 <ChevronRight size={14}/><strong>{sectionName}</strong></div><div className="topbar-right"><span className="workspace-pill">{state.currentUser?.displayName}</span><button className="text-button" onClick={()=>{setOldPassword('');setNewPassword('');setConfirmPassword('');setPasswordError('');setPasswordOpen(true);}}>修改密码</button><button className="text-button" onClick={async()=>{if(view==='form'&&!window.confirm('当前表单尚未保存，确定退出？'))return;try{await securityRepository.logout();}catch(e){fail(e);}}}>退出</button></div></header>
    <main className="main-content"><div className="workspace-note"><span className="info-symbol" aria-hidden="true">i</span><span>仅展示当前账号获授权的公司与秘密等级资料。</span>{state.capabilities.manage&&localCount > 0 && <button className="text-button" disabled={saving} onClick={migrate}>迁移本机草稿（{localCount}）</button>}</div>
      {notice && <div className={`notice ${notice.error ? 'danger' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{!notice.error && <CheckCircle2 size={17}/>}<span>{notice.message}</span><button className="text-button" aria-label="关闭提示" onClick={() => setNotice(null)}>关闭</button></div>}
      {view === 'form' && record ? <RecordForm key={`${record.id}-${record.recordVersion}`} record={record} state={state} editing={editing} saving={saving} onSave={saveRecord} onCancel={() => { setView('ledger'); setRecord(null); }}/>
        : view === 'companies' ? <CompanyAdmin state={state} save={saveMaster} saving={saving}/>
        : view === 'categories' ? <CategoryAdmin state={state} save={saveMaster} saving={saving}/>
        : view==='security'&&state.capabilities.manage?<SecurityAdmin state={state} onRefresh={refreshMaster}/>
        : view==='audit'&&state.capabilities.manage?<AuditView/>
        : view==='reminders'||view==='statistics'?<AnalyticsView state={state} mode={view} onOpen={openReminder}/>
        : <Ledger state={state} data={data} loading={loading} error={listError} filters={filters} changeFilters={changeFilters} page={page} pageSize={pageSize} setPage={setPage} setPageSize={value => { setPageSize(value); setPage(1); }} saving={saving} onNew={openNew} onDetail={openDetail} onEdit={openEdit} onRegister={registerRecord} onVoid={item => { setVoidReason(''); setVoidTarget(item); }} onImport={()=>setImportOpen(true)} onExport={exportExcel} onRefresh={async () => { try { setState(await archiveRepository.load()); setReload(n => n + 1); } catch (e) { fail(e); } }}/>
      }
    </main><footer className="app-footer">万盛 · 档案台账管理系统<span>公司档案统一登记与查询</span></footer></div>
    {detail && <RecordDetail record={detail} state={state} onClose={() => setDetail(null)} onEdit={() => openEdit(detail)} onRegister={() => registerRecord(detail)} onVoid={() => { setVoidReason(''); setVoidTarget(detail); setDetail(null); }} saving={saving}/>}
    {importOpen&&<ExcelImport state={state} company={filters.company} group={filters.group} onClose={()=>setImportOpen(false)} onImported={()=>setReload(n=>n+1)}/>}
    {passwordOpen&&<Modal title="修改密码" onClose={()=>!saving&&setPasswordOpen(false)}><form onSubmit={async e=>{e.preventDefault();if(newPassword!==confirmPassword)return setPasswordError('两次新密码不一致。');setSaving(true);setPasswordError('');try{await securityRepository.password(oldPassword,newPassword);}catch(e){setPasswordError((e as Error).message);}finally{setSaving(false);}}}><div className="modal-body form-grid single">{passwordError&&<div role="alert" className="notice danger">{passwordError}</div>}<label className="field"><span>原密码</span><input type="password" autoComplete="current-password" required value={oldPassword} onChange={e=>setOldPassword(e.target.value)}/></label><label className="field"><span>新密码</span><input type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><label className="field"><span>确认新密码</span><input type="password" required value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/></label><small>修改成功后，当前账号所有会话失效，需要重新登录。</small></div><div className="modal-footer"><button type="button" className="button" onClick={()=>setPasswordOpen(false)}>取消</button><button className="button primary" disabled={saving}>保存新密码</button></div></form></Modal>}
    {voidTarget && <Modal title="作废档案" onClose={() => !saving && setVoidTarget(null)}><div className="modal-body"><p>档号 {voidTarget.archiveNumber} 将继续保留，作废后不可编辑。</p><label className="field" style={{ marginTop: 18 }}><span>作废原因 *</span><textarea rows={3} maxLength={1000} value={voidReason} onChange={e => setVoidReason(e.target.value)}/></label></div><div className="modal-footer"><button className="button" disabled={saving} onClick={() => setVoidTarget(null)}>取消</button><button className="button danger-button" disabled={saving || !voidReason.trim()} onClick={voidRecord}>确认作废</button></div></Modal>}
  </div>;
}
