import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, reject, parse, editableSchema, masterSchema, validateRecord, findPath } from './schema.mjs';
import { actor,scopeSQL,assertRead,assertWrite,requireAdmin,requireWrite,audit } from './access.mjs';

const referencePath = fileURLToPath(new URL('../seed/reference.json', import.meta.url));
const now = () => new Date().toISOString();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flatten = (nodes, parentId = null) => nodes.flatMap(n => [{ ...n, parentId }, ...flatten(n.children, n.id)]);
const clean = record => Object.fromEntries(Object.keys(editableSchema.shape).map(k => [k, record[k]]));
const fingerprint = record => createHash('sha256').update(JSON.stringify(clean(record))).digest('hex');

export class ArchiveStore {
  constructor(filename) {
    if(filename!==':memory:'&&existsSync(filename)){
      const existing=new DatabaseSync(filename,{readOnly:true});
      try{
        if(existing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get()){
          const schema=Number(existing.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value||1);
          if(schema>3)throw new Error('Database schema is newer than this release. Startup refused.');
        }
      }finally{existing.close();}
    }
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, code TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS departments(id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), name TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(company_id,name));
      CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES categories(id), code TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS category_sibling_code ON categories(COALESCE(parent_id,''),code);
      CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), group_type TEXT NOT NULL CHECK(group_type IN ('document','qualification')), title TEXT NOT NULL,
        certificate_number TEXT NOT NULL, archive_number TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('draft','registered','void')),
        numbering_year TEXT NOT NULL, data TEXT NOT NULL, record_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        registered_at TEXT, voided_at TEXT, void_reason TEXT NOT NULL DEFAULT '', registration_snapshot TEXT);
      CREATE TABLE IF NOT EXISTS archive_categories(archive_id TEXT NOT NULL REFERENCES archives(id), category_id TEXT NOT NULL REFERENCES categories(id), position INTEGER NOT NULL, PRIMARY KEY(archive_id,position));
      CREATE INDEX IF NOT EXISTS archives_company_status ON archives(company_id,status);
      CREATE INDEX IF NOT EXISTS archive_category_filter ON archive_categories(category_id,archive_id);
      CREATE TABLE IF NOT EXISTS numbering_counters(scope TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value>0));
      CREATE TABLE IF NOT EXISTS archive_events(id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES archives(id), event_type TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS phase2_migrations(source_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, imported_at TEXT NOT NULL);
    `);
    this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('revision')) {
        const source = JSON.parse(readFileSync(referencePath, 'utf8'));
        this.writeMaster(source);
        this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('revision', '1');
        this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('schema_version', '1');
      }
    });
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  revision() { return Number(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('revision').value); }
  readTransaction(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  master() {
    return this.readTransaction(() => this.readMaster());
  }
  readMaster() {
    const companies = this.db.prepare('SELECT data FROM companies ORDER BY rowid').all().map(r => JSON.parse(r.data));
    const departments = this.db.prepare('SELECT data FROM departments ORDER BY rowid').all().map(r => JSON.parse(r.data));
    const rows = this.db.prepare('SELECT id,parent_id,data FROM categories ORDER BY rowid').all();
    const nodes = new Map(rows.map(r => [r.id, { ...JSON.parse(r.data), children: [] }]));
    const categories = [];
    for (const row of rows) row.parent_id ? nodes.get(row.parent_id).children.push(nodes.get(row.id)) : categories.push(nodes.get(row.id));
    const hasLevels=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='confidentiality_levels'").get();
    const confidentialityLevels=hasLevels?this.db.prepare('SELECT id,name,enabled,version AS levelVersion FROM confidentiality_levels ORDER BY rowid').all().map(l=>({...l,enabled:!!l.enabled})):[];
    return { version: 1, revision: this.revision(), companies, departments, categories, confidentialityLevels, records: [], numbering: { qualificationPrefix: 'ZZ', documentPrefix: 'WS', separator: '-', minDigits: 3, yearBasis: 'archive', confirmed: true } };
  }
  writeMaster(master) {
    for (const company of master.companies) this.db.prepare('INSERT INTO companies(id,name,code,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,data=excluded.data').run(company.id, company.name, company.code, JSON.stringify(company));
    for (const department of master.departments) this.db.prepare('INSERT INTO departments VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET company_id=excluded.company_id,name=excluded.name,data=excluded.data').run(department.id, department.companyId, department.name, JSON.stringify(department));
    for (const category of flatten(master.categories)) {
      const { parentId, children, ...data } = category;
      this.db.prepare('INSERT INTO categories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,code=excluded.code,data=excluded.data').run(data.id, parentId, data.code, JSON.stringify(data));
    }
  }
  validateMaster(next, previous) {
    const categories = flatten(next.categories);
    const unique = (values, message) => { if (new Set(values).size !== values.length) reject(message); };
    unique(next.companies.map(c => c.id), '公司ID重复。'); unique(next.companies.map(c => c.name), '公司名称重复。');
    unique(next.companies.filter(c => c.code).map(c => c.code), '公司编码重复。');
    unique(next.departments.map(d => d.id), '部门ID重复。'); unique(next.departments.map(d => `${d.companyId}\0${d.name}`), '同一公司下部门名称重复。');
    unique(categories.map(c => c.id), '分类ID重复。'); unique(categories.map(c => `${c.parentId || ''}\0${c.code}`), '同一上级下分类编码重复。');
    if (categories.length > 3000 || categories.some(c => c.id.length > 120)) reject('分类目录超过可维护范围。');
    const inspectDepth = (nodes, depth = 0) => { if (depth > 7) reject('分类最多支持8层。'); for (const n of nodes) if (n.children.length) inspectDepth(n.children, depth + 1); }; inspectDepth(next.categories);
    for (const d of next.departments) if (!next.companies.some(c => c.id === d.companyId)) reject('部门关联的公司不存在。');
    for (const [name, oldItems, newItems] of [['公司', previous.companies, next.companies], ['部门', previous.departments, next.departments], ['分类', flatten(previous.categories), categories]]) {
      if (oldItems.some(old => !newItems.some(n => n.id === old.id))) reject(`${name}请使用停用功能，不能直接删除已有条目。`);
    }
    for (const d of previous.departments) {
      if (next.departments.find(n => n.id === d.id)?.companyId !== d.companyId && this.db.prepare("SELECT 1 FROM archives WHERE json_extract(data,'$.departmentId')=? LIMIT 1").get(d.id)) reject('已被档案引用的部门不能变更所属公司。');
    }
    const registered = this.db.prepare("SELECT * FROM archives WHERE status!='draft'").all();
    for (const row of registered) {
      const record = this.hydrate(row);
      const oldCompany = previous.companies.find(c => c.id === record.companyId);
      const company = next.companies.find(c => c.id === record.companyId);
      if (oldCompany.code !== company.code) reject('已有正式档案的公司不能修改公司编码。');
      const oldPath = findPath(previous.categories, record.categoryIds), newPath = findPath(next.categories, record.categoryIds);
      if (!same(oldPath.map(n => [n.id, n.code]), newPath.map(n => [n.id, n.code])) || oldPath[0]?.mode !== newPath[0]?.mode) reject('已有正式档案的分类路径、编码及编号模式不能修改；可以修改显示名称或停用。');
    }
  }
  saveMaster(input) {
    requireAdmin();
    const next = parse(masterSchema, input);
    return this.transaction(() => {
      const previous = this.master();
      if (next.revision !== previous.revision) reject('基础资料已被其他页面更新，请刷新后重试。', 'REVISION_CONFLICT', 409);
      this.validateMaster(next, previous); this.writeMaster(next);
      this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(previous.revision + 1), 'revision');
      audit(this,'master_updated','',{before:{companies:previous.companies,departments:previous.departments,categories:previous.categories},after:next});
      return this.master();
    });
  }
  hydrate(row) {
    if (!row) throw new ApiError(404, 'NOT_FOUND', '档案不存在。');
    const scope=scopeSQL('a');
    const duplicate = row.certificate_number ? this.db.prepare(`SELECT count(*) AS count FROM archives a WHERE certificate_number=? AND id!=? AND status!='void' AND (${scope.sql})`).get(row.certificate_number,row.id,...scope.args).count : 0;
    return { ...JSON.parse(row.data), recordVersion: row.record_version, status: row.status, archiveNumber: row.archive_number, createdAt: row.created_at, updatedAt: row.updated_at, registeredAt: row.registered_at, voidedAt: row.voided_at, voidReason: row.void_reason, registrationSnapshot: row.registration_snapshot ? JSON.parse(row.registration_snapshot) : null, warnings: duplicate ? ['存在相同证书编号的档案，请核查是否为不同版本。'] : [] };
  }
  get(id) { const record=this.hydrate(this.db.prepare('SELECT * FROM archives WHERE id=?').get(id));assertRead(record);return record; }
  event(id, type, detail) { this.db.prepare('INSERT INTO archive_events VALUES(?,?,?,?,?)').run(randomUUID(), id, type, JSON.stringify(detail), now());audit(this,type,id,detail,this.get(id)); }
  insertDraft(record) {
    assertWrite(record);
    const timestamp = now();
    this.db.prepare('INSERT INTO archives(id,company_id,group_type,title,certificate_number,archive_number,status,numbering_year,data,record_version,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?,?,1,?,?)').run(record.id, record.companyId, record.group, record.title, record.certificateNumber, 'draft', record.numberingYear, JSON.stringify({ ...record, recordVersion: 1 }), timestamp, timestamp);
    this.syncRecordCategories(record); this.event(record.id, 'draft_created', {after:record});
    return this.get(record.id);
  }
  syncRecordCategories(record) {
    this.db.prepare('DELETE FROM archive_categories WHERE archive_id=?').run(record.id);
    record.categoryIds.forEach((id, i) => this.db.prepare('INSERT INTO archive_categories VALUES(?,?,?)').run(record.id, id, i));
  }
  createDraft(input) {
    requireWrite();
    const record = parse(editableSchema, input);
    assertWrite(record);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM archives WHERE id=?').get(record.id);
      if (existing) {
        const old = this.hydrate(existing), a = { ...clean(old), recordVersion: 0 }, b = { ...record, recordVersion: 0 };
        if (old.status === 'draft' && same(a, b)) return old;
        reject('该档案ID已存在且内容不同，请刷新后重试。', 'ID_CONFLICT', 409);
      }
      if (record.recordVersion !== 0) reject('新档案版本应为0。');
      validateRecord(record, this.master()); return this.insertDraft(record);
    });
  }
  updateRecord(id, input) {
    requireWrite();
    const record = parse(editableSchema, input);
    assertWrite(record);
    if (record.id !== id) reject('档案ID与请求地址不一致。');
    return this.transaction(() => {
      const old = this.get(id);
      if (old.recordVersion !== record.recordVersion) reject('档案已被修改，请刷新后重试。', 'REVISION_CONFLICT', 409);
      if (old.status === 'void') reject('作废档案只读，不能修改。', 'ARCHIVE_VOID', 409);
      if (old.status === 'registered' && !same([old.companyId, old.group, old.categoryIds, old.numberingYear], [record.companyId, record.group, record.categoryIds, record.numberingYear])) reject('正式档案不能直接修改归属、分类或编号年份；请作废后重新登记。', 'NUMBERING_FIELDS_LOCKED', 409);
      validateRecord(record, this.master(), false, old.status === 'registered');
      const nextVersion = old.recordVersion + 1;
      this.db.prepare('UPDATE archives SET company_id=?,group_type=?,title=?,certificate_number=?,numbering_year=?,data=?,record_version=?,updated_at=? WHERE id=?').run(record.companyId, record.group, record.title, record.certificateNumber, record.numberingYear, JSON.stringify({ ...record, recordVersion: nextVersion }), nextVersion, now(), id);
      this.syncRecordCategories(record); this.event(id, 'updated', { previousVersion: old.recordVersion,before:clean(old),after:record }); return this.get(id);
    });
  }
  register(id, recordVersion) {
    requireWrite();
    return this.transaction(() => {
      const record = this.get(id);
      if (record.status === 'registered') return record; // Retry never consumes a new number.
      if (record.status === 'void') reject('作废档案不能重新入账。', 'ARCHIVE_VOID', 409);
      if (record.recordVersion !== recordVersion) reject('档案已被修改，请刷新后重试。', 'REVISION_CONFLICT', 409);
      const { company, path: categoryPath } = validateRecord(record, this.master(), true);
      const yearly = record.group === 'document' && categoryPath[0].mode === 'year';
      const scope = JSON.stringify([record.companyId, record.group, record.categoryIds, yearly ? record.numberingYear : null]);
      const value = Number(this.db.prepare('INSERT INTO numbering_counters(scope,value) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET value=value+1 RETURNING value').get(scope).value);
      const parts = [company.code, record.group === 'document' ? 'WS' : 'ZZ', ...categoryPath.map(c => c.code), ...(yearly ? [record.numberingYear] : []), String(value).padStart(3, '0')];
      const snapshot = { companyName: company.name, companyCode: company.code, group: record.group, categoryPath: categoryPath.map(c => ({ id: c.id, code: c.code, name: c.name })), year: yearly ? record.numberingYear : null, sequence: value };
      this.db.prepare("UPDATE archives SET archive_number=?,status='registered',record_version=record_version+1,registered_at=?,updated_at=?,registration_snapshot=? WHERE id=?").run(parts.join('-'), now(), now(), JSON.stringify(snapshot), id);
      this.event(id, 'registered', { archiveNumber: parts.join('-'), scope, sequence: value });
      return this.get(id);
    });
  }
  void(id, recordVersion, reason) {
    requireWrite();
    return this.transaction(() => {
      const record = this.get(id);
      if (record.status === 'void') {
        if (record.voidReason === reason) return record;
        reject('档案已作废，不能覆盖原作废原因。', 'ARCHIVE_VOID', 409);
      }
      if (record.status !== 'registered') reject('只有正式登记的档案可以作废。');
      if (record.recordVersion !== recordVersion) reject('档案已被修改，请刷新后重试。', 'REVISION_CONFLICT', 409);
      this.db.prepare("UPDATE archives SET status='void',voided_at=?,void_reason=?,updated_at=?,record_version=record_version+1 WHERE id=?").run(now(), reason, now(), id);
      this.event(id, 'voided', { reason, archiveNumber: record.archiveNumber }); return this.get(id);
    });
  }
  list(params) {
    return this.readTransaction(() => this.queryList(params));
  }
  queryList(params) {
    const page = Number(params.get('page') || '1'), pageSize = Number(params.get('pageSize') || '10');
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) reject('分页参数无效。');
    const scope=scopeSQL('a');const clauses = [scope.sql], args = [...scope.args];
    for (const [key, column, allowed] of [['company', 'a.company_id'], ['group', 'a.group_type', ['document', 'qualification']], ['status', 'a.status', ['draft', 'registered', 'void']]]) {
      const value = params.get(key); if (!value) continue;
      if (allowed && !allowed.includes(value)) reject('筛选值无效。'); clauses.push(`${column}=?`); args.push(value);
    }
    if (params.get('category')) { clauses.push('EXISTS(SELECT 1 FROM archive_categories ac WHERE ac.archive_id=a.id AND ac.category_id=?)'); args.push(params.get('category')); }
    if (params.get('department')) { clauses.push("json_extract(a.data,'$.departmentId')=?"); args.push(params.get('department')); }
    if (params.get('validity')) { if (!['fixed','permanent','na','unknown'].includes(params.get('validity'))) reject('有效期类型无效。'); clauses.push("json_extract(a.data,'$.validityMode')=?"); args.push(params.get('validity')); }
    const keyword = (params.get('keyword') || '').trim();
    if (keyword.length > 200) reject('关键词过长。');
    if (keyword) { clauses.push('(instr(lower(a.title),lower(?))>0 OR instr(lower(a.certificate_number),lower(?))>0 OR instr(lower(COALESCE(a.archive_number,\'\')),lower(?))>0 OR instr(lower(c.name),lower(?))>0)'); args.push(keyword, keyword, keyword, keyword); }
    const base = `FROM archives a JOIN companies c ON c.id=a.company_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`;
    const total = Number(this.db.prepare(`SELECT count(*) AS total ${base}`).get(...args).total);
    const records = this.db.prepare(`SELECT a.* ${base} ORDER BY a.created_at DESC,a.rowid DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page-1)*pageSize).map(row => this.hydrate(row));
    const counts = this.db.prepare(`SELECT status,count(*) as count FROM archives a WHERE ${scope.sql} GROUP BY status`).all(...scope.args);
    const stats = { draft: 0, registered: 0, void: 0 }; counts.forEach(c => { stats[c.status] = Number(c.count); });
    return { records, total, page, pageSize, stats };
  }
  importPhase2(input) {
    requireAdmin();
    const inputSchema = z.object({ companies: z.array(masterSchema.shape.companies.element), departments: z.array(masterSchema.shape.departments.element), categories: z.array(masterSchema.shape.categories.element), records: z.array(z.unknown()).max(5000) });
    const source = parse(inputSchema, input);
    return this.transaction(() => {
      const previous = this.master();
      const merge = (oldItems, newItems, label) => {
        const result = [...oldItems];
        for (const item of newItems) {
          const old = result.find(n => n.id === item.id);
          if (old && !same(old, item)) reject(`${label}“${item.name}”与数据库配置不同，请先核对基础资料后再迁移。`, 'MIGRATION_CONFLICT', 409);
          if (!old) result.push(item);
        } return result;
      };
      const mergeTree = (old, incoming) => incoming.reduce((nodes, item) => {
        const found = nodes.find(n => n.id === item.id);
        if (!found) return [...nodes, item];
        if (!same({ ...found, children: [] }, { ...item, children: [] })) reject(`分类“${item.name}”与数据库配置不同，请先核对后再迁移。`, 'MIGRATION_CONFLICT', 409);
        return nodes.map(n => n.id === item.id ? { ...n, children: mergeTree(n.children, item.children) } : n);
      }, old);
      const master = { ...previous, companies: merge(previous.companies, source.companies, '公司'), departments: merge(previous.departments, source.departments, '部门'), categories: mergeTree(previous.categories, source.categories) };
      this.validateMaster(master, previous); this.writeMaster(master);
      let imported = 0, skipped = 0, excludedExamples = 0;
      for (const original of source.records) {
        if (original && original.isExample === true) { excludedExamples++; continue; }
        const record = parse(editableSchema, { ...Object.fromEntries(Object.keys(editableSchema.shape).filter(k => k !== 'recordVersion').map(k => [k, original?.[k]])), recordVersion: 0 });
        validateRecord(record, master);
        const hash = fingerprint(record), migrated = this.db.prepare('SELECT fingerprint FROM phase2_migrations WHERE source_id=?').get(record.id);
        if (migrated) { if (migrated.fingerprint !== hash) reject('该本机草稿迁移后又有修改，请人工核对，未覆盖数据库记录。', 'MIGRATION_CONFLICT', 409); skipped++; continue; }
        if (this.db.prepare('SELECT 1 FROM archives WHERE id=?').get(record.id)) reject('迁移草稿ID与数据库记录冲突，未覆盖。', 'MIGRATION_CONFLICT', 409);
        this.insertDraft(record); this.db.prepare('INSERT INTO phase2_migrations VALUES(?,?,?)').run(record.id, hash, now()); imported++;
      }
      this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(previous.revision + 1), 'revision');
      return { imported, skipped, excludedExamples };
    });
  }
}
