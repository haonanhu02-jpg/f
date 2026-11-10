'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Save, FolderOpen, FileText, Package, Info } from 'lucide-react';
import { type ArchiveRecord, type Workspace, type Category, resolvePath, validateDraft, validityLabels, retentionLabels } from './model';
import { Field, Badge } from './ui';
import Attachments from './Attachments';

export function CategoryPicker({ categories, ids, onChange, disabled = false, required = true }: { categories: Category[]; ids: string[]; onChange: (ids: string[]) => void; disabled?: boolean; required?: boolean }) {
  const levels: Category[][] = [categories];
  let options = categories;
  for (const id of ids) {
    const node = options.find(n => n.id === id);
    if (!node?.children.length) break;
    levels.push(node.children); options = node.children;
  }
  return <>{levels.map((nodes, index) => <Field key={index} label={index === 0 ? '二级分类' : index === 1 ? '三级分类' : `下级分类（第${index + 2}层）`} required={required}><select disabled={disabled} value={ids[index] ?? ''} onChange={e => onChange([...ids.slice(0, index), ...(e.target.value ? [e.target.value] : [])])}><option value="">请选择分类</option>{nodes.map(n => <option key={n.id} value={n.id} disabled={!n.enabled}>{n.code} · {n.name}{!n.enabled ? '（已停用）' : ''}</option>)}</select></Field>)}</>;
}

export default function RecordForm({ record, state, editing, saving, onSave, onCancel }: { record: ArchiveRecord; state: Workspace; editing: boolean; saving: boolean; onSave: (record: ArchiveRecord, register?: boolean) => Promise<boolean>; onCancel: () => void }) {
  const [form, setForm] = useState(record);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const patch = (values: Partial<ArchiveRecord>) => { setForm(f => ({ ...f, ...values })); setDirty(true); setError(''); };
  const company = state.companies.find(c => c.id === form.companyId);
  const path = resolvePath(state.categories, form.categoryIds);
  const numberedByYear = form.group === 'document' && path[0]?.mode === 'year';
  const registered = form.status === 'registered';
  const saveLabel = registered ? '保存修改' : '保存草稿';
  const cancel = () => { if (!dirty || window.confirm('当前修改尚未保存，确定返回台账吗？')) onCancel(); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = { ...form, title: form.title.trim(), certificateNumber: form.certificateNumber.trim(), numberingYear: numberedByYear ? form.numberingYear : '',
      validFrom: form.validityMode === 'fixed' ? form.validFrom : '', validUntil: form.validityMode === 'fixed' ? form.validUntil : '',
      retentionUntil: form.retentionMode === 'fixed' ? form.retentionUntil : '', updatedAt: new Date().toISOString() };
    const problem = validateDraft(normalized, state);
    if (problem) { setError(problem); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    await onSave(normalized, submitter?.value === 'register');
  }
  return <form onSubmit={submit} className="record-form">
    <div className="page-heading"><div><button type="button" className="back-link" onClick={cancel}><ArrowLeft size={15}/>返回档案台账</button><div className="title-row"><h1>{editing ? '编辑档案' : '新增档案'}</h1><Badge tone={registered ? 'green' : 'blue'}>{registered ? '已登记' : '数据库草稿'}</Badge></div><p>先选择归属与分类，再登记档案信息。</p></div><button className="button primary" type="submit" disabled={saving}><Save size={16}/>{saving ? '正在保存…' : saveLabel}</button></div>
    {error && <div className="notice danger" role="alert">{error}</div>}
    <section className="panel"><div className="section-title"><FolderOpen size={18}/><h2>归属与分类</h2></div><div className="form-grid">
      <Field label="所属公司" required><select disabled={registered} value={form.companyId} onChange={e => patch({ companyId: e.target.value, categoryIds: [], departmentId: '', numberingYear: '' })}><option value="">请选择公司</option>{state.companies.map(c => <option key={c.id} value={c.id} disabled={!c.enabled}>{c.name}{!c.enabled ? '（已停用）' : ''}</option>)}</select></Field>
      <Field label="档案大类" required><select disabled={registered} value={form.group} onChange={e => { const group = e.target.value as ArchiveRecord['group']; patch({ group, categoryIds: [], numberingYear: '', validityMode: group === 'document' ? 'na' : 'unknown', validFrom: '', validUntil: '' }); }}><option value="document">文书档案类</option><option value="qualification">资质类（含证书）</option></select></Field>
      {form.group === 'document' && (company?.categoryEnabled || registered) && <CategoryPicker disabled={registered} categories={state.categories} ids={form.categoryIds} onChange={ids => patch({ categoryIds: ids, numberingYear: '' })}/>}
      {numberedByYear && <Field label="归档年份" required hint="此类按所选归档年份独立编号。"><input disabled={registered} inputMode="numeric" maxLength={4} value={form.numberingYear} placeholder="例如 2026" onChange={e => patch({ numberingYear: e.target.value })}/></Field>}
    </div>
    {!registered && form.group === 'document' && !company?.categoryEnabled && <div className="notice amber">该公司尚未启用文书目录，请先在“公司与部门”中确认适用范围。</div>}
    {!company?.code && <div className="notice amber">公司编码待补。可准备草稿，补齐编码后才能正式入账。</div>}
    {path[0]?.mode === 'unresolved' && <div className="notice amber">该分类的细则待明确，当前仅保存草稿。</div>}
    <div className="number-preview"><Info size={17}/><div><strong>档号：{form.archiveNumber || '待正式入账后分配'}</strong><p>{registered ? '归属、分类及归档年份已锁定；如登记有误，可作废后重新登记。' : `${company?.code || '公司编码待补'} · ${form.group === 'qualification' ? '资质类 / 连续编号' : `${path.map(n => n.name).join(' / ') || '请选择分类'} / ${numberedByYear ? '按年编号' : '连续编号'}`}`}</p></div></div>
    </section>
    <section className="panel"><div className="section-title"><FileText size={18}/><h2>档案基本信息</h2></div><div className="form-grid">
      <Field label={form.group === 'qualification' ? '证件名称' : '档案名称'} required><input value={form.title} maxLength={200} placeholder="填写完整名称" onChange={e => patch({ title: e.target.value })}/></Field>
      <Field label="证书编号" hint="与系统档号分别保存，保留前导零。"><input value={form.certificateNumber} maxLength={100} placeholder="适用时填写" onChange={e => patch({ certificateNumber: e.target.value })}/></Field>
      <Field label="发证单位"><input value={form.issuingAuthority} maxLength={200} placeholder="适用时填写" onChange={e => patch({ issuingAuthority: e.target.value })}/></Field>
      <Field label="发证日期"><input type="date" value={form.issuedOn} onChange={e => patch({ issuedOn: e.target.value })}/></Field>
      <Field label="证件有效期"><select value={form.validityMode} onChange={e => patch({ validityMode: e.target.value as ArchiveRecord['validityMode'], validFrom: '', validUntil: '' })}>{Object.entries(validityLabels).map(([v, l]) => <option value={v} key={v}>{l}</option>)}</select></Field>
      {form.validityMode === 'fixed' && <><Field label="有效开始日期"><input type="date" value={form.validFrom} onChange={e => patch({ validFrom: e.target.value })}/></Field><Field label="有效到期日期" required><input type="date" value={form.validUntil} onChange={e => patch({ validUntil: e.target.value })}/></Field></>}
      {(['originalCount', 'copyCount', 'scanCount'] as const).map((key, i) => <Field label={['原件数量（份）', '复印件数量（份）', '扫描件数量（份）'][i]} key={key} hint={i === 2 ? '按份登记，与上传文件数分开。' : '留空表示待核实，0 表示没有。'}><input type="number" min="0" step="1" value={form[key] ?? ''} placeholder="待核实" onChange={e => patch({ [key]: e.target.value === '' ? null : Number(e.target.value) })}/></Field>)}
    </div></section>
    <section className="panel"><div className="section-title"><Package size={18}/><h2>移交与保管</h2></div><div className="form-grid">
      <Field label="移交人"><input value={form.transferPerson} maxLength={100} placeholder="填写移交人姓名" onChange={e => patch({ transferPerson: e.target.value })}/></Field>
      <Field label="移交部门" hint={!state.departments.some(d => d.companyId === form.companyId && d.enabled) ? '该公司暂无部门，可在基础管理中新增。' : undefined}><select value={form.departmentId} onChange={e => patch({ departmentId: e.target.value })}><option value="">未填写</option>{state.departments.filter(d => d.companyId === form.companyId).map(d => <option key={d.id} value={d.id} disabled={!d.enabled}>{d.name}{!d.enabled ? '（已停用）' : ''}</option>)}</select></Field>
      <Field label="秘密等级" hint={state.confidentialityLevels.length?'仅显示账号获授权的等级；未定密单独授权。':'字典待补，未定密不代表公开。'}><select value={form.confidentialityLevel} onChange={e=>patch({confidentialityLevel:e.target.value})}><option value="" disabled={!state.capabilities.unclassified}>待核定（未定密）</option>{state.confidentialityLevels.map(l=><option key={l.id} value={l.id} disabled={!l.enabled}>{l.name}{!l.enabled?'（已停用）':''}</option>)}</select></Field>
      <Field label="保存期限"><select value={form.retentionMode} onChange={e => patch({ retentionMode: e.target.value as ArchiveRecord['retentionMode'], retentionUntil: '' })}>{Object.entries(retentionLabels).map(([v, l]) => <option value={v} key={v}>{l}</option>)}</select></Field>
      <Field label="保存开始日期"><input type="date" value={form.retentionFrom} onChange={e => patch({ retentionFrom: e.target.value })}/></Field>
      {form.retentionMode === 'fixed' && <Field label="保存终止日期" required><input type="date" value={form.retentionUntil} onChange={e => patch({ retentionUntil: e.target.value })}/></Field>}
      <Field label="存放位置"><input value={form.storageLocation} maxLength={200} placeholder="档案室 / 柜号 / 层号 / 盒号" onChange={e => patch({ storageLocation: e.target.value })}/></Field>
      <Field label="备注" wide><textarea rows={3} value={form.remarks} maxLength={5000} placeholder="补充档案说明" onChange={e => patch({ remarks: e.target.value })}/></Field>
    </div><Attachments record={form} disabled={saving} canUpload={state.capabilities.write} canDownload={state.capabilities.download}/></section>
    <div className="form-footer"><span>{registered ? '修改保管等信息不会改变正式档号。' : '保存草稿不占号；正式入账时由后端分配档号。'}</span><div className="actions"><button type="button" className="button" onClick={cancel}>取消</button><button type="submit" className="button" disabled={saving}>{saveLabel}</button>{!registered && <button type="submit" name="action" value="register" className="button primary" disabled={saving}>保存并正式入账</button>}</div></div>
  </form>;
}
