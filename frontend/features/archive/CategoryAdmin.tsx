'use client';
import { useState, type FormEvent } from 'react';
import { Plus, Folder, Search } from 'lucide-react';
import { type Workspace, type Category, flattenCategories, updateCategory } from './model';
import { Field, Badge, Modal, Empty } from './ui';

const modeLabels = { continuous: '连续编号', year: '按年编号', unresolved: '细则待明确' };
export default function CategoryAdmin({ state, save, saving }: { state: Workspace; save: (next: Workspace, message: string) => Promise<boolean>; saving: boolean }) {
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ node: Category; parentId: string; isNew: boolean } | null>(null);
  const [error, setError] = useState('');
  const flat = flattenCategories(state.categories);
  const rows = flat.filter(({ node }) => `${node.code} ${node.name}`.includes(query.trim()));
  function edit(node: Category, isNew = false, parentId = '') { setError(''); setEditor({ node: { ...node }, parentId, isNew }); }
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!editor) return;
    const node = { ...editor.node, code: editor.node.code.trim(), name: editor.node.name.trim() };
    if (!node.name || !/^\d{2}$/.test(node.code)) return setError('请填写分类名称和两位数字编码。');
    const parent = flat.find(x => x.node.id === editor.parentId)?.node;
    const siblings = editor.parentId ? parent?.children ?? [] : state.categories;
    if (siblings.some(n => n.id !== node.id && n.code === node.code)) return setError('同一上级下的分类编码不能重复。');
    let categories: Category[];
    if (editor.isNew) categories = editor.parentId ? updateCategory(state.categories, editor.parentId, p => ({ ...p, children: [...p.children, node] })) : [...state.categories, node];
    else categories = updateCategory(state.categories, node.id, () => node);
    if (await save({ ...state, categories }, '分类目录已保存到本机。')) setEditor(null);
  }
  return <>
    <div className="page-heading"><div><div className="eyebrow">基础管理</div><h1>分类与编码</h1><p>维护文书档案分类层级，保留原表编码与特殊分支。</p></div><button className="button primary" onClick={() => edit({ id: crypto.randomUUID(), code: '', name: '', enabled: true, source: '手工维护', mode: 'continuous', children: [] }, true)}><Plus size={16}/>新增分类</button></div>
    <div className="metric-strip"><div><strong>{state.categories.length}</strong><span>二级类别</span></div><div><strong>{flat.length - state.categories.length}</strong><span>下级分类</span></div><div><strong>{state.categories.filter(c => c.mode === 'year').length}</strong><span>按年编号类别</span></div></div>
    <div className="notice info">普通类别按公司与分类路径连续编号；原表“年份流水号”类别按年重新编号。XXX、20XX 不作为可选分类。</div>
    <section className="panel"><div className="toolbar"><div className="section-title"><Folder size={18}/><h2>文书档案目录</h2></div><div className="search-input"><Search size={16}/><input aria-label="搜索分类" placeholder="搜索编码或分类名称" value={query} onChange={e => setQuery(e.target.value)}/></div></div><div className="table-scroll"><table className="category-table"><thead><tr><th>分类名称 / 层级</th><th>编码</th><th>规则 / 来源</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(({ node, depth }) => <tr key={node.id}><td><div className="category-name" style={{ paddingLeft: depth * 22 }}><Folder size={15}/><span>{node.name}<small>{depth === 0 ? '二级分类' : depth === 1 ? '三级分类' : '更深一级分类'}</small></span></div></td><td><code>{node.code}</code></td><td>{depth === 0 && <Badge tone={node.mode === 'unresolved' ? 'amber' : 'blue'}>{modeLabels[node.mode]}</Badge>}<small>{node.source}</small></td><td><Badge tone={node.enabled ? 'green' : 'neutral'}>{node.enabled ? '启用中' : '已停用'}</Badge></td><td><div className="row-actions"><button onClick={() => { const parent = flat.find(p => p.node.children.some(c => c.id === node.id)); edit(node, false, parent?.node.id || ''); }}>编辑</button><button disabled={saving} onClick={() => save({ ...state, categories: updateCategory(state.categories, node.id, n => ({ ...n, enabled: !n.enabled })) }, '分类状态已更新，原有草稿仍保留。')}>{node.enabled ? '停用' : '启用'}</button></div></td></tr>)}</tbody></table>{!rows.length && <Empty title="没有匹配的分类" description="试试其他名称或编码。"/>}</div><div className="table-footer">原表未提供14类，未自动补建。停用上级后，其下级不会用于新增档案。</div></section>
    {editor && <Modal title={editor.isNew ? '新增分类' : '编辑分类'} onClose={() => setEditor(null)}><form onSubmit={submit}><div className="modal-body form-grid single">{error && <div role="alert" className="notice danger">{error}</div>}<Field label="上级分类"><select disabled={!editor.isNew} value={editor.parentId} onChange={e => setEditor({ ...editor, parentId: e.target.value })}><option value="">无上级（新增二级类别）</option>{flat.map(({ node, depth }) => <option key={node.id} value={node.id}>{'　'.repeat(depth)}{node.code} · {node.name}</option>)}</select></Field><Field label="分类编码" required hint="保留两位数字；同一上级下不可重复。"><input value={editor.node.code} maxLength={2} onChange={e => setEditor({ ...editor, node: { ...editor.node, code: e.target.value } })}/></Field><Field label="分类名称" required><input maxLength={200} value={editor.node.name} onChange={e => setEditor({ ...editor, node: { ...editor.node, name: e.target.value } })}/></Field>{!editor.parentId && <Field label="流水号规则"><select value={editor.node.mode} onChange={e => setEditor({ ...editor, node: { ...editor.node, mode: e.target.value as Category['mode'] } })}>{Object.entries(modeLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}</div><div className="modal-footer"><button className="button" type="button" onClick={() => setEditor(null)}>取消</button><button className="button primary" type="submit" disabled={saving}>保存分类</button></div></form></Modal>}
  </>;
}
