"""End-to-end checks against an isolated API/database, never the real workspace."""
import json
import os
import re
import subprocess
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
OUT = ROOT / 'outputs'
OUT.mkdir(exist_ok=True)
database = PROJECT / 'backend/outputs' / ('browser-' + str(uuid.uuid4()) + '.sqlite')
database.parent.mkdir(exist_ok=True)
environment = {**os.environ, 'PORT': '0', 'ARCHIVE_DB_PATH': str(database)}
process = subprocess.Popen(['node', 'src/server.mjs'], cwd=PROJECT/'backend', env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
line = process.stdout.readline()
match = re.search(r'http://127\.0\.0\.1:\d+', line)
if not match:
    process.terminate()
    raise RuntimeError('Isolated API did not start: ' + line)
API = match.group(0)
checks = []
errors = []

def done(name):
    checks.append(name)
    print('PASS:', name, flush=True)

try:
    with sync_playwright() as p:
        executable = Path.home()/'AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe'
        browser = p.chromium.launch(executable_path=str(executable), headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, locale='zh-CN')
        # Route API requests to a separate ephemeral backend. The real 3001 database is untouched.
        def api_route(route):
            suffix = route.request.url.split('/api', 1)[1]
            response = route.fetch(url=API+'/api'+suffix)
            route.fulfill(response=response)
        context.request.post(API+'/api/auth/setup',data=dict(username='browser-admin',displayName='浏览器验收管理员',password='Browser-acceptance-password-2026'))
        context.route('**/api/**', api_route)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('http://127.0.0.1:5173', wait_until='networkidle')
        expect(page.get_by_role('heading', name='暂无匹配的档案')).to_be_visible()
        done('Initial frontend uses isolated empty database')
        page.get_by_role('button', name='新增档案', exact=True).first.click()
        page.get_by_label('二级分类', exact=False).select_option('cat-01')
        page.get_by_label('三级分类', exact=False).select_option('cat-01-01')
        page.get_by_label('档案名称', exact=False).fill('浏览器验收 · 规划许可档案')
        page.get_by_label('证书编号', exact=False).fill('00123')
        page.get_by_label('原件数量', exact=False).fill('0')
        page.get_by_role('button', name='保存并正式入账').click()
        expect(page.locator('.ledger-table').get_by_text('GF-WS-01-01-001', exact=True)).to_be_visible()
        done('Create and register through UI receives the backend archive number')
        page.get_by_role('button', name='详情', exact=True).click()
        expect(page.get_by_role('dialog').get_by_text('00123', exact=True)).to_be_visible()
        page.get_by_role('button', name='编辑档案', exact=True).click()
        expect(page.get_by_label('所属公司', exact=False)).to_be_disabled()
        expect(page.get_by_label('二级分类', exact=False)).to_be_disabled()
        page.get_by_label('存放位置', exact=False).fill('档案室 / A柜 / 02层')
        page.get_by_role('button', name='保存修改', exact=True).first.click()
        page.reload(wait_until='networkidle')
        expect(page.get_by_text('档案室 / A柜 / 02层', exact=True)).to_be_visible()
        done('Registered identity is locked; content edits persist across reload')
        page.get_by_role('button', name='作废', exact=True).click()
        page.get_by_label('作废原因', exact=False).fill('验收用误录记录')
        page.get_by_role('button', name='确认作废', exact=True).click()
        expect(page.locator('.ledger-table').get_by_text('已作废', exact=True)).to_be_visible()
        expect(page.locator('.ledger-table').get_by_text('GF-WS-01-01-001', exact=True)).to_be_visible()
        page.get_by_role('button', name='新增档案', exact=True).first.click()
        page.get_by_label('二级分类', exact=False).select_option('cat-01')
        page.get_by_label('三级分类', exact=False).select_option('cat-01-01')
        page.get_by_label('档案名称', exact=False).fill('浏览器验收 · 第二份许可')
        page.get_by_role('button', name='保存并正式入账').click()
        expect(page.locator('.ledger-table').get_by_text('GF-WS-01-01-002', exact=True)).to_be_visible()
        done('Void reason retained and the next registration never recycles its number')
        page.get_by_placeholder('档案名称 / 档号 / 证书编号').fill('GF-WS-01-01-002')
        page.get_by_role('button', name='查询', exact=True).click()
        expect(page.locator('.ledger-table tbody tr')).to_have_count(1)
        page.get_by_role('button', name='重置', exact=True).click()
        expect(page.locator('.ledger-table tbody tr')).to_have_count(2)
        page.get_by_role('button', name='高级筛选', exact=True).click()
        page.get_by_label('登记状态', exact=False).select_option('void')
        expect(page.locator('.ledger-table tbody tr')).to_have_count(1)
        done('Server-side archive-number and lifecycle filtering')
        page.get_by_role('button', name='重置', exact=True).click()
        page.get_by_role('button', name='新增档案', exact=True).first.click()
        page.get_by_label('二级分类', exact=False).select_option('cat-20')
        page.get_by_label('归档年份', exact=False).fill('2027')
        page.get_by_label('档案名称', exact=False).fill('浏览器验收 · 年份合同')
        page.get_by_role('button', name='保存并正式入账').click()
        expect(page.locator('.ledger-table').get_by_text('GF-WS-20-2027-001', exact=True)).to_be_visible()
        done('Selected archive year appears in the official number')
        page.get_by_role('button', name='新增档案', exact=True).first.click()
        page.get_by_label('所属公司', exact=False).select_option('company-34')
        page.get_by_label('档案大类', exact=False).select_option('qualification')
        page.get_by_label('证件名称', exact=False).fill('浏览器验收 · 编码待补证照')
        page.get_by_role('button', name='保存并正式入账').click()
        expect(page.get_by_role('alert').filter(has_text='公司编码待补')).to_be_visible()
        page.get_by_role('button', name='返回档案台账', exact=True).click()
        expect(page.locator('.ledger-table tbody tr')).to_have_count(1)
        expect(page.locator('.ledger-table').get_by_text('草稿', exact=True)).to_be_visible()
        done('Registration failure preserves the saved draft without consuming a number')
        page.get_by_role('button', name='公司与部门', exact=True).click()
        page.get_by_role('tab', name='部门目录').click()
        page.get_by_role('button', name='新增部门', exact=True).click()
        page.get_by_label('部门名称', exact=False).fill('后端验收部门')
        page.get_by_role('button', name='保存部门', exact=True).click()
        page.reload(wait_until='networkidle')
        page.get_by_role('button', name='公司与部门', exact=True).click()
        page.get_by_role('tab', name='部门目录').click()
        expect(page.get_by_text('后端验收部门', exact=True)).to_be_visible()
        done('Master-data changes persist in the database')
        # Prepare an old local workspace with one real draft and one example.
        bootstrap = context.request.get(API+'/api/bootstrap').json()['data']
        local_record = dict(id=str(uuid.uuid4()), companyId='company-4', group='qualification', categoryIds=[], title='本机迁移验收', certificateNumber='', issuingAuthority='', issuedOn='', originalCount=None, copyCount=None, scanCount=None, validityMode='unknown', validFrom='', validUntil='', transferPerson='', departmentId='', confidentialityLevel='', retentionMode='unknown', retentionFrom='', retentionUntil='', storageLocation='', remarks='', numberingYear='', isExample=False, updatedAt='2026-11-09T00:00:00Z')
        local = dict(version=1,companies=bootstrap['companies'],departments=bootstrap['departments'],categories=bootstrap['categories'],records=[local_record, {**local_record,'id':str(uuid.uuid4()),'isExample':True}])
        page.evaluate('(value)=>localStorage.setItem("wansheng.archive.phase2.v1",JSON.stringify(value))', local)
        page.reload(wait_until='networkidle')
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='迁移本机草稿（1）').click()
        expect(page.get_by_role('status').filter(has_text='新增1条')).to_be_visible()
        assert page.evaluate('JSON.parse(localStorage.getItem("wansheng.archive.phase2.v1")).records.length') == 2
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='迁移本机草稿（1）').click()
        expect(page.get_by_role('status').filter(has_text='已迁移跳过1条')).to_be_visible()
        done('Explicit local migration skips examples, preserves the original and is idempotent')
        page.get_by_role('button', name='重置', exact=True).click()
        expect(page.locator('.ledger-table tbody tr')).to_have_count(5)
        page.get_by_role('button', name='关闭提示').click()
        page.screenshot(path=str(OUT/'phase3-ledger-desktop.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(OUT/'phase3-ledger-mobile.png'),full_page=True)
        page.set_viewport_size({'width':320,'height':720})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        done('Desktop and mobile layouts remain usable')
        assert not errors, errors
        done('No browser runtime errors')
        browser.close()
finally:
    process.terminate()
    process.wait(timeout=15)
    assert database.parent.resolve() == (PROJECT/'backend/outputs').resolve()
    for suffix in ('','-wal','-shm'):
        Path(str(database)+suffix).unlink(missing_ok=True)

(OUT/'phase3-browser-checks.json').write_text(json.dumps({'passed':checks,'runtime_errors':errors,'isolation':'Dedicated ephemeral API and SQLite database; live workspace unchanged'},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed_count':len(checks),'runtime_errors':errors},ensure_ascii=False),flush=True)
