"""UI acceptance for setup, authorization, reminders, statistics and audit, on isolated DB."""
import json,os,re,subprocess,uuid
from pathlib import Path
from datetime import date,timedelta
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];PROJECT=ROOT.parent;OUT=ROOT/'outputs';OUT.mkdir(exist_ok=True)
database=PROJECT/'backend/outputs'/('browser-phase5-'+str(uuid.uuid4())+'.sqlite');database.parent.mkdir(exist_ok=True)
process=subprocess.Popen(['node','src/server.mjs'],cwd=PROJECT/'backend',env={**os.environ,'PORT':'0','ARCHIVE_DB_PATH':str(database)},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
match=re.search(r'http://127\.0\.0\.1:\d+',process.stdout.readline())
if not match:process.terminate();raise RuntimeError('Isolated API failed to start')
API=match.group(0);PASS='Browser-security-password-2026';checks=[];errors=[]
def done(text):checks.append(text);print('PASS:',text,flush=True)
def fixture(**changes):
    return {**dict(id=str(uuid.uuid4()),companyId='company-4',group='qualification',categoryIds=[],title='权限验收',certificateNumber='',issuingAuthority='',issuedOn='',originalCount=1,copyCount=None,scanCount=1,validityMode='unknown',validFrom='',validUntil='',transferPerson='',departmentId='',confidentialityLevel='',retentionMode='unknown',retentionFrom='',retentionUntil='',storageLocation='',remarks='',numberingYear='',isExample=False,recordVersion=0),**changes}
try:
    with sync_playwright() as p:
        executable=Path.home()/'AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe'
        browser=p.chromium.launch(executable_path=str(executable),headless=True)
        def route_api(route):route.fulfill(response=route.fetch(url=API+'/api'+route.request.url.split('/api',1)[1]))
        context=browser.new_context(viewport={'width':1440,'height':1000},locale='zh-CN');context.route('**/api/**',route_api)
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:5173',wait_until='networkidle')
        expect(page.get_by_role('heading',name='创建首位管理员')).to_be_visible()
        page.get_by_label('账号',exact=True).fill('admin');page.get_by_label('姓名',exact=True).fill('验收管理员');page.get_by_label('密码',exact=True).fill(PASS);page.get_by_label('再次输入密码',exact=True).fill(PASS);page.get_by_role('button',name='创建管理员并登录').click()
        expect(page.get_by_role('heading',name='档案台账',exact=True)).to_be_visible()
        done('First-user setup and cookie-based authenticated application')
        page.get_by_role('button',name='权限管理',exact=True).click();page.get_by_role('button',name='秘密等级字典',exact=True).click()
        expect(page.get_by_text('秘密等级待补，尚未创建任何等级。',exact=True)).to_be_visible()
        page.get_by_role('button',name='新增秘密等级',exact=True).click();page.get_by_label('等级名称',exact=False).fill('验收级别甲');page.get_by_role('button',name='保存秘密等级',exact=True).click()
        expect(page.get_by_role('cell',name='验收级别甲',exact=True)).to_be_visible()
        session=context.request.get(API+'/api/auth/session').json()['data'];csrf=session['csrfToken']
        def post(route,body):
            response=context.request.post(API+route,data=body,headers={'X-CSRF-Token':csrf});assert response.ok,response.text();return response.json()['data']
        levels=context.request.get(API+'/api/security/levels').json()['data'];levelA=levels[0]['id'];levelB=post('/api/security/levels',dict(name='验收级别乙',enabled=True))['id']
        today=context.request.get(API+'/api/statistics').json()['data']['today'];yesterday=(date.fromisoformat(today)-timedelta(days=1)).isoformat()
        own=post('/api/archive-drafts',fixture(title='授权证照验收',confidentialityLevel=levelA,certificateNumber='00123',validityMode='fixed',validUntil=today,retentionMode='fixed',retentionUntil=yesterday));post('/api/archive-drafts/'+own['id']+'/register',dict(recordVersion=1))
        for record in [fixture(title='其他密级验收',confidentialityLevel=levelB),fixture(title='未定密验收'),fixture(title='其他公司验收',companyId='company-5',confidentialityLevel=levelA)]:
            r=post('/api/archive-drafts',record);post('/api/archive-drafts/'+r['id']+'/register',dict(recordVersion=1))
        png=bytes.fromhex('89504e470d0a1a0a')+b'fixture'
        uploaded=context.request.post(API+f"/api/archives/{own['id']}/attachments?filename=test.png",data=png,headers={'X-CSRF-Token':csrf,'Content-Type':'application/octet-stream'});assert uploaded.ok
        file_id=uploaded.json()['data']['id']
        done('Configurable confidentiality dictionary without preset levels')
        page.get_by_role('button',name='到期提醒',exact=True).click();expect(page.get_by_label('提前提醒天数')).to_have_value('30')
        expect(page.get_by_role('cell',name='当天到期',exact=True)).to_be_visible();expect(page.get_by_role('cell',name='已过期1天',exact=True)).to_be_visible()
        page.get_by_label('提醒类型').select_option('retention');expect(page.locator('tbody tr')).to_have_count(1)
        page.screenshot(path=str(OUT/'phase5-reminders.png'),full_page=True)
        page.get_by_role('button',name='统计汇总',exact=True).click();expect(page.get_by_text('授权档案总数',exact=True)).to_be_visible();expect(page.locator('.metric-strip').first).to_contain_text('4')
        page.screenshot(path=str(OUT/'phase5-statistics.png'),full_page=True)
        done('Shanghai date reminders, retention expiry and reconciled statistics pages')
        page.get_by_role('button',name='权限管理',exact=True).click();page.get_by_role('button',name='新增账号',exact=True).click()
        page.get_by_role('dialog').get_by_role('textbox',name=re.compile('^账号')).fill('reader');page.get_by_label('姓名',exact=False).fill('验收查询人');page.get_by_label('初始密码',exact=False).fill(PASS)
        page.get_by_label('浙江万盛股份有限公司',exact=True).check();page.get_by_label('验收级别甲',exact=True).check();page.get_by_role('button',name='保存账号授权',exact=True).click()
        expect(page.get_by_role('cell').filter(has_text='reader')).to_be_visible();page.screenshot(path=str(OUT/'phase5-permissions.png'),full_page=True)
        reader_context=browser.new_context(viewport={'width':1280,'height':900},locale='zh-CN');reader_context.route('**/api/**',route_api)
        reader=reader_context.new_page();reader.on('pageerror',lambda e:errors.append(str(e)));reader.goto('http://127.0.0.1:5173',wait_until='networkidle')
        reader.get_by_label('账号',exact=True).fill('reader');reader.get_by_label('密码',exact=True).fill(PASS);reader.get_by_role('button',name='登录',exact=True).click()
        expect(reader.locator('.ledger-table tbody tr')).to_have_count(1);expect(reader.get_by_role('button',name='新增档案',exact=True)).to_be_disabled();expect(reader.get_by_role('button',name='权限管理',exact=True)).to_have_count(0)
        expect(reader.locator('.ledger-table').get_by_role('button',name='编辑',exact=True)).to_have_count(0);expect(reader.get_by_role('button',name='导出台账',exact=True)).to_be_disabled()
        reader.get_by_role('button',name='详情',exact=True).click();expect(reader.locator('.attachment-list li')).to_have_count(1);expect(reader.get_by_text('原文件未授权',exact=True)).to_be_visible();expect(reader.get_by_role('link',name='下载',exact=True)).to_have_count(0)
        assert reader_context.request.get(API+f'/api/attachments/{file_id}/content').status==403
        reader.get_by_role('button',name='关闭',exact=True).click();reader.get_by_role('button',name='统计汇总',exact=True).click();expect(reader.locator('.metric-strip').first).to_contain_text('1')
        done('Viewer company/level filtering, read-only UI and raw-file/export enforcement')
        page.get_by_role('button',name='操作日志',exact=True).click();page.get_by_label('日志操作筛选').select_option('user_created');expect(page.locator('tbody tr')).to_have_count(1);page.get_by_text('查看变更',exact=True).click();expect(page.locator('.audit-detail')).to_contain_text('reader');assert PASS not in page.locator('.audit-detail').inner_text()
        page.screenshot(path=str(OUT/'phase5-audit.png'),full_page=True)
        done('Admin audit page records authorization changes without password disclosure')
        page.get_by_role('button',name='权限管理',exact=True).click();page.locator('tbody tr').filter(has_text='reader').get_by_role('button',name='编辑授权',exact=True).click();page.get_by_label('启用账号',exact=False).uncheck();page.get_by_role('button',name='保存账号授权',exact=True).click();expect(page.get_by_role('dialog')).to_have_count(0)
        reader.get_by_role('button',name='档案台账',exact=True).click();expect(reader.get_by_role('heading',name='登录档案系统',exact=True)).to_be_visible()
        done('Account disable revokes an existing browser session immediately')
        page.get_by_role('button',name='修改密码',exact=True).click();page.get_by_label('原密码',exact=True).fill(PASS);page.get_by_label('新密码',exact=True).fill('Changed-browser-password-2026');page.get_by_label('确认新密码',exact=True).fill('Changed-browser-password-2026');page.get_by_role('button',name='保存新密码',exact=True).click();expect(page.get_by_role('heading',name='登录档案系统',exact=True)).to_be_visible()
        page.get_by_label('账号',exact=True).fill('admin');page.get_by_label('密码',exact=True).fill('Changed-browser-password-2026');page.get_by_role('button',name='登录',exact=True).click();expect(page.get_by_role('heading',name='档案台账',exact=True)).to_be_visible()
        page.set_viewport_size({'width':390,'height':844});page.get_by_role('button',name='到期提醒',exact=True).click();expect(page.get_by_role('heading',name='到期提醒',exact=True)).to_be_visible();assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth');page.screenshot(path=str(OUT/'phase5-mobile.png'),full_page=True)
        page.set_viewport_size({'width':320,'height':720});assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        done('Password change, re-login and mobile authorized-navigation layouts')
        assert not errors,errors;done('No browser runtime errors')
        browser.close()
finally:
    process.terminate();process.wait(timeout=15);assert database.parent.resolve()==(PROJECT/'backend/outputs').resolve()
    for suffix in ('','-wal','-shm'):Path(str(database)+suffix).unlink(missing_ok=True)
(OUT/'phase5-browser-checks.json').write_text(json.dumps({'passed':checks,'runtime_errors':errors,'isolation':'Independent API and database; no real accounts created'},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed_count':len(checks),'runtime_errors':errors},ensure_ascii=False),flush=True)
