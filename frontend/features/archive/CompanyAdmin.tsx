'use client';
import { useState, type FormEvent } from 'react';
import { Plus, Building2, Search } from 'lucide-react';
import { type Workspace, type Company, type Department } from './model';
import { Field, Badge, Modal, Empty } from './ui';

export default function CompanyAdmin({ state, save, saving }: { state: Workspace; save: (next: Workspace, message: string) => Promise<boolean>; saving: boolean }) {
  const [tab, setTab] = useState('companies');
  const [query, setQuery] = useState('');
  const [departmentCompany, setDepartmentCompany] = useState('');
  const [company, setCompany] = useState<Company | null>(null);
  const [department, setDepartment] = useState<Department | null>(null);
  const [error, setError] = useState('');
  const companies = state.companies.filter(c => `${c.name} ${c.shortName} ${c.code ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const departments = state.departments.filter(d => (!departmentCompany || d.companyId === departmentCompany) && d.name.includes(query.trim()));
  async function saveCompany(e: FormEvent) {
    e.preventDefault(); if (!company) return;
    const normalized = { ...company, name: company.name.trim(), shortName: company.shortName.trim(), code: company.code?.trim().toUpperCase() || null };
    if (!normalized.name) return setError('请填写公司全称。');
    if (state.companies.some(c => c.id !== company.id && c.name === normalized.name)) return setError('公司名称已存在。');
    if (normalized.code && !/^[A-Z][A-Z0-9]*$/.test(normalized.code)) return setError('公司编码请使用英文字母开头的大写字母或数字。');
    if (normalized.code && state.companies.some(c => c.id !== company.id && c.code === normalized.code)) return setError('公司编码已存在，请使用唯一编码。');
    const exists = state.companies.some(c => c.id === company.id);
    const next = { ...state, companies: exists ? state.companies.map(c => c.id === company.id ? normalized : c) : [...state.companies, normalized] };
    if (await save(next, '公司资料已保存到本机。')) setCompany(null);
  }
  async function saveDepartment(e: FormEvent) {
    e.preventDefault(); if (!department) return;
    const normalized = { ...department, name: department.name.trim() };
    if (!normalized.name || !state.companies.some(c => c.id === normalized.companyId && c.enabled)) return setError('请选择启用中的公司并填写部门名称。');
    if (state.departments.some(d => d.id !== normalized.id && d.companyId === normalized.companyId && d.name === normalized.name)) return setError('该公司已经存在同名部门。');
    const exists = state.departments.some(d => d.id === normalized.id);
    if (await save({ ...state, departments: exists ? state.departments.map(d => d.id === normalized.id ? normalized : d) : [...state.departments, normalized] }, '部门资料已保存到本机。')) setDepartment(null);
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow">基础管理</div><h1>公司与部门</h1><p>维护所属公司、部门，以及文书目录的适用范围。</p></div><button className="button primary" onClick={() => { setError(''); tab === 'companies' ? setCompany({ id: crypto.randomUUID(), name: '', code: null, shortName: '', enabled: true, categoryEnabled: false }) : setDepartment({ id: crypto.randomUUID(), companyId: departmentCompany || state.companies.find(c => c.enabled)?.id || '', name: '', enabled: true }); }}><Plus size={16}/>{tab === 'companies' ? '新增公司' : '新增部门'}</button></div>
    <div className="metric-strip"><div><strong>{state.companies.length}</strong><span>公司主体</span></div><div><strong>{state.companies.filter(c => !c.code).length}</strong><span>编码待补</span></div><div><strong>{state.departments.length}</strong><span>已维护部门</span></div></div>
    <section className="panel"><div className="tabs" role="tablist" aria-label="公司与部门"><button role="tab" aria-selected={tab === 'companies'} onClick={() => { setTab('companies'); setQuery(''); }}>公司目录</button><button role="tab" aria-selected={tab === 'departments'} onClick={() => { setTab('departments'); setQuery(''); }}>部门目录</button></div>
      <div className="toolbar"><div className="search-input"><Search size={16}/><input aria-label="搜索公司或部门" value={query} onChange={e => setQuery(e.target.value)} placeholder={tab === 'companies' ? '搜索公司名称、简称或编码' : '搜索部门名称'}/></div>{tab === 'departments' && <select aria-label="部门所属公司筛选" value={departmentCompany} onChange={e => setDepartmentCompany(e.target.value)}><option value="">全部公司</option>{state.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</div>
      {tab === 'companies' ? <div className="table-scroll"><table><thead><tr><th>公司名称 / 简称</th><th>公司编码</th><th>文书目录</th><th>状态</th><th>操作</th></tr></thead><tbody>{companies.map(c => <tr key={c.id}><td><div className="company-name"><Building2 size={16}/><strong>{c.name}</strong></div><small>{c.shortName || '简称待补'}</small></td><td>{c.code ? <code>{c.code}</code> : <Badge tone="amber">待补</Badge>}</td><td><Badge tone={c.categoryEnabled ? 'blue' : 'neutral'}>{c.categoryEnabled ? '已启用' : '适用范围待确认'}</Badge></td><td><Badge tone={c.enabled ? 'green' : 'neutral'}>{c.enabled ? '启用中' : '已停用'}</Badge></td><td><div className="row-actions"><button onClick={() => { setError(''); setCompany({ ...c }); }}>编辑</button><button disabled={saving} onClick={() => save({ ...state, companies: state.companies.map(x => x.id === c.id ? { ...x, enabled: !x.enabled } : x) }, c.enabled ? '公司已停用，现有草稿仍保留。' : '公司已启用。')}>{c.enabled ? '停用' : '启用'}</button></div></td></tr>)}</tbody></table>{!companies.length && <Empty title="没有匹配的公司" description="试试其他名称或编码。"/>}</div> : departments.length ? <div className="table-scroll"><table><thead><tr><th>部门名称</th><th>所属公司</th><th>状态</th><th>操作</th></tr></thead><tbody>{departments.map(d => <tr key={d.id}><td><strong>{d.name}</strong></td><td>{state.companies.find(c => c.id === d.companyId)?.name}</td><td><Badge tone={d.enabled ? 'green' : 'neutral'}>{d.enabled ? '启用中' : '已停用'}</Badge></td><td><div className="row-actions"><button onClick={() => { setError(''); setDepartment({ ...d }); }}>编辑</button><button disabled={saving} onClick={() => save({ ...state, departments: state.departments.map(x => x.id === d.id ? { ...x, enabled: !x.enabled } : x) }, '部门状态已更新。')}>{d.enabled ? '停用' : '启用'}</button></div></td></tr>)}</tbody></table></div> : <Empty title="暂无部门" description="Excel 未提供部门名单，请根据实际组织情况新增。"/>}
      <div className="table-footer">{tab === 'companies' ? `共 ${companies.length} 家公司 · 原表33家公司，30个已有编码` : `共 ${departments.length} 个部门`}</div>
    </section>
    {company && <Modal title={state.companies.some(c => c.id === company.id) ? '编辑公司' : '新增公司'} onClose={() => setCompany(null)}><form onSubmit={saveCompany}><div className="modal-body form-grid single">{error && <div className="notice danger" role="alert">{error}</div>}<Field label="公司全称" required><input value={company.name} maxLength={300} onChange={e => setCompany({ ...company, name: e.target.value })}/></Field><Field label="公司简称"><input value={company.shortName} maxLength={100} onChange={e => setCompany({ ...company, shortName: e.target.value })}/></Field><Field label="公司编码" hint="暂缺可以留空；正式入账前须补齐。"><input value={company.code || ''} maxLength={30} onChange={e => setCompany({ ...company, code: e.target.value.toUpperCase() })}/></Field><label className="check-row"><input type="checkbox" checked={company.categoryEnabled} onChange={e => setCompany({ ...company, categoryEnabled: e.target.checked })}/><span>已确认适用当前文书目录，启用分类选择</span></label></div><div className="modal-footer"><button type="button" className="button" onClick={() => setCompany(null)}>取消</button><button type="submit" className="button primary" disabled={saving}>保存公司</button></div></form></Modal>}
    {department && <Modal title={state.departments.some(d => d.id === department.id) ? '编辑部门' : '新增部门'} onClose={() => setDepartment(null)}><form onSubmit={saveDepartment}><div className="modal-body form-grid single">{error && <div className="notice danger" role="alert">{error}</div>}<Field label="所属公司" required><select value={department.companyId} disabled={state.records.some(r => r.departmentId === department.id)} onChange={e => setDepartment({ ...department, companyId: e.target.value })}><option value="">请选择公司</option>{state.companies.map(c => <option key={c.id} value={c.id} disabled={!c.enabled}>{c.name}{!c.enabled ? '（已停用）' : ''}</option>)}</select></Field><Field label="部门名称" required><input maxLength={100} value={department.name} onChange={e => setDepartment({ ...department, name: e.target.value })}/></Field></div><div className="modal-footer"><button type="button" className="button" onClick={() => setDepartment(null)}>取消</button><button type="submit" className="button primary" disabled={saving}>保存部门</button></div></form></Modal>}
  </>;
}
