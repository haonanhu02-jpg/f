import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '../docs/phase-1');
const companies = JSON.parse(readFileSync(path.join(source, '公司目录.json'), 'utf8'));
const categories = JSON.parse(readFileSync(path.join(source, '分类目录.json'), 'utf8'));
function convert(node, ancestors = []) {
  const codes = [...ancestors, node.code];
  return {
    id: `cat-${codes.join('-')}`, code: node.code, name: node.name,
    source: node.source, enabled: true,
    mode: !ancestors.length && ['08', '19'].includes(node.code) ? 'unresolved' : node.numbering_hint?.source_code === '20XX' ? 'year' : 'continuous',
    children: (node.children ?? []).map(child => convert(child, codes)),
  };
}
const data = {
  version: 1,
  companies: companies.map(c => ({ id: `company-${c.source_row}`, name: c.name, code: c.code, shortName: c.short_name || '', enabled: true, categoryEnabled: c.code === 'GF' })),
  departments: [], categories: categories.map(c => convert(c)), records: [],
};
writeFileSync(path.join(root, 'features/archive/reference.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
const backend = path.resolve(root, '../backend');
if (existsSync(backend)) {
  mkdirSync(path.join(backend, 'seed'), { recursive: true });
  writeFileSync(path.join(backend, 'seed/reference.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
}
console.log(`Reference synced: ${data.companies.length} companies; ${data.categories.length} categories. Browser data was not modified.`);
