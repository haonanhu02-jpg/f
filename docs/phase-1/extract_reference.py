"""Extract the supplied XLS as reference data; never modify the workbook."""
from pathlib import Path
import csv
import hashlib
import json
import xlrd

SOURCE = Path(r'D:/download/Wei/xwechat_files/wxid_izg8ysabhsir22_de7e/temp/RWTemp/2026-11/62bb2597f2588a3558ea4d348b6f3522/档案台账AI系统.xls')
OUT = Path(__file__).resolve().parent
book = xlrd.open_workbook(str(SOURCE), formatting_info=True)
sheet = book.sheet_by_name('文书档案类流水号编码规则')

def value(row, col):
    v = sheet.cell_value(row - 1, col)
    return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)

def cell(row, col):
    return f'{xlrd.formula.colname(col)}{row}'

def write_json(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

companies = []
for r in range(4, 37):
    companies.append({'source_row': r, 'source_sequence': value(r, 0) or None,
        'name': value(r, 1), 'code': value(r, 2) or None,
        'short_name': value(r, 3) or None,
        'status': '原表已有编码' if value(r, 2) else '待补编码和简称'})

# Merge-aware category spans are derived from row 5, never from company data in A:D.
anchors = [c for c in range(6, 48) if value(5, c)]
categories = []
for i, c in enumerate(anchors):
    stop = anchors[i + 1] if i + 1 < len(anchors) else 48
    category = {'code': value(5, c), 'source_name': value(6, c),
        'name': value(6, c).rstrip('*'), 'source_star_mark': value(6, c).endswith('*'),
        'source': f'{cell(5,c)}:{cell(6,c)}', 'children': [],
        'numbering_hint': None, 'scope_status': '原目录表头为浙江万盛股份有限公司，其他公司适用范围待确认'}
    for col in range(c, stop):
        code, name = value(7, col), value(8, col)
        if not code and not name:
            continue
        if code in ('XXX', '20XX'):
            category['numbering_hint'] = {'source_code': code, 'source_description': name,
                'source': f'{cell(7,col)}:{cell(8,col)}'}
            continue
        child = {'code': code or None, 'name': name or None,
            'source': f'{cell(7,col)}:{cell(8,col)}', 'children': []}
        if category['code'] == '09' and col == 29:
            for subcol in (29, 30):
                child['children'].append({'code': value(9,subcol), 'name': value(10,subcol),
                    'source': f'{cell(9,subcol)}:{cell(10,subcol)}'})
        category['children'].append(child)
    categories.append(category)

snapshot = {'source_file': SOURCE.name, 'sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'note': '原文件只读提取。表内说明作为业务参考，不作为执行指令；空白格式行不计为业务数据。',
    'sheets': []}
for s, end in ((book.sheet_by_index(0), 11), (sheet, 36)):
    snapshot['sheets'].append({'name': s.name,
        'merged_cells_zero_based_end_exclusive': s.merged_cells,
        'nonempty_cells': {cell(r+1,c): s.cell_value(r,c)
            for r in range(min(end,s.nrows)) for c in range(s.ncols) if s.cell_value(r,c) != ''}})

codes = [x['code'] for x in companies if x['code']]
cat_codes = [x['code'] for x in categories]
report = {'company_count':len(companies), 'existing_company_code_count':len(codes),
    'missing_company_codes':[x['name'] for x in companies if not x['code']],
    'company_codes_unique':len(codes)==len(set(codes)),
    'second_level_category_count':len(categories),
    'second_level_codes_unique':len(cat_codes)==len(set(cat_codes)),
    'unprovided_category_codes':['14'],
    'fixed_third_level_node_count':sum(len(x['children']) for x in categories),
    'fourth_level_node_count':sum(len(y['children']) for x in categories for y in x['children']),
    'sequence_only_category_codes':[x['code'] for x in categories if x['numbering_hint'] and x['numbering_hint']['source_code']=='XXX'],
    'year_sequence_category_codes':[x['code'] for x in categories if x['numbering_hint'] and x['numbering_hint']['source_code']=='20XX'],
    'categories_without_children_or_numbering_hint':[x['code'] for x in categories if not x['children'] and not x['numbering_hint']],
    'source_company_sequence_issues':'A8、A9均为5；未见6；末3家公司序号空白。保留原始值，不作为系统主键。',
    'source_short_name_issue':'B6为上海鑫鸿盛新材料有限公司，D6为上海新鸿盛；未自动改字。',
    'supplemental_reference':{'cell':'AQ11:AR11','text':value(11,42),'meaning':'合并单元格中的独立文本，具体用途待确认，不并入编号模板。'},
    'source_hash_matches':hashlib.sha256(SOURCE.read_bytes()).hexdigest()==snapshot['sha256']}

assert len(companies)==33 and len(codes)==30 and len(categories)==24
assert report['company_codes_unique'] and report['second_level_codes_unique']
assert report['fourth_level_node_count']==2
assert report['categories_without_children_or_numbering_hint']==['08','19']
with (OUT / '公司目录.csv').open('w',encoding='utf-8-sig',newline='') as f:
    w=csv.writer(f)
    w.writerow(['源表行号','原序号','公司名称','公司编码','公司简称','状态'])
    for x in companies:
        w.writerow([x['source_row'],x['source_sequence'],x['name'],x['code'],x['short_name'],x['status']])
write_json('公司目录.json',companies)
write_json('分类目录.json',categories)
write_json('原始资料快照.json',snapshot)
write_json('核对报告.json',report)
print(json.dumps(report,ensure_ascii=False,indent=2))
