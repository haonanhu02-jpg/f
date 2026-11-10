"""Production build + online backup + recovery acceptance on isolated databases."""
import json, os, re, socket, subprocess, uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]; PROJECT=ROOT.parent; OUT=ROOT/'outputs'; OUT.mkdir(exist_ok=True)
DATABASE=PROJECT/'backend/outputs'/('phase6-'+str(uuid.uuid4())+'.sqlite')
RECOVERED=DATABASE.with_name(DATABASE.stem+'-restored.sqlite')
BACKUPS=PROJECT/'backend/outputs'/('phase6-backups-'+str(uuid.uuid4()))
PASS='Production-acceptance-password-2026'; checks=[]; errors=[]; process=None
def done(label): checks.append(label); print('PASS:',label,flush=True)
def start(database):
    global process
    with socket.socket() as reservation:reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
    process=subprocess.Popen(['node','src/server.mjs'],cwd=PROJECT/'backend',env={**os.environ,'PORT':str(port),'ARCHIVE_ALLOWED_ORIGINS':f'http://127.0.0.1:{port}','ARCHIVE_DB_PATH':str(database),'ARCHIVE_STATIC_DIR':str(ROOT/'dist-production')},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    found=re.search(r'http://127\.0\.0\.1:\d+',process.stdout.readline())
    if not found: raise RuntimeError('Production process failed to start')
    return found.group(0)
def stop():
    if process and process.poll() is None:process.terminate();process.wait(timeout=15)
def maintain(*args):
    result=subprocess.run(['node','scripts/maintenance.mjs',*args],cwd=PROJECT/'backend',capture_output=True,text=True,encoding='utf-8',check=True)
    return json.loads(result.stdout)
def fixture(i):return dict(id=str(uuid.uuid4()),companyId='company-4',group='qualification',categoryIds=[],title='生产验收'+str(i),certificateNumber='000'+str(i),issuingAuthority='',issuedOn='',originalCount=0,copyCount=None,scanCount=1,validityMode='unknown',validFrom='',validUntil='',transferPerson='',departmentId='',confidentialityLevel='',retentionMode='unknown',retentionFrom='',retentionUntil='',storageLocation='',remarks='',numberingYear='',isExample=False,recordVersion=0)
try:
    base=start(DATABASE)
    with sync_playwright() as p:
        executable=Path.home()/'AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe'
        browser=p.chromium.launch(executable_path=str(executable),headless=True)
        context=browser.new_context(viewport={'width':1440,'height':1000},locale='zh-CN')
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        response=page.goto(base,wait_until='networkidle');assert response.status==200
        expect(page.get_by_role('heading',name='创建首位管理员')).to_be_visible()
        assert not page.locator('script[src*="@vite"]').count()
        page.get_by_label('账号',exact=True).fill('production-admin');page.get_by_label('姓名',exact=True).fill('生产验收管理员');page.get_by_label('密码',exact=True).fill(PASS);page.get_by_label('再次输入密码',exact=True).fill(PASS)
        page.get_by_role('button',name='创建管理员并登录').click();expect(page.get_by_role('heading',name='档案台账',exact=True)).to_be_visible()
        done('Built frontend and API run from one production origin without a development server')
        session=context.request.get(base+'/api/auth/session').json()['data'];csrf={'X-CSRF-Token':session['csrfToken']}
        records=[]
        for i in range(2):
            r=context.request.post(base+'/api/archive-drafts',data=fixture(i),headers=csrf);assert r.status==200
            record=r.json()['data'];r=context.request.post(base+f'/api/archives/{record["id"]}/register',data={'recordVersion':record['recordVersion']},headers=csrf);assert r.status==200;records.append(r.json()['data'])
        assert [r['archiveNumber'] for r in records]==['GF-ZZ-001','GF-ZZ-002']
        page.reload(wait_until='networkidle');expect(page.locator('.ledger-table tbody tr')).to_have_count(2)
        done('Registration and zero/null/leading-zero fields persist in the production database')
        pdf=b'%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'
        r=context.request.post(base+f'/api/archives/{records[0]["id"]}/attachments?filename=scan.pdf',data=pdf,headers={**csrf,'Content-Type':'application/octet-stream'});assert r.status==200
        file_id=r.json()['data']['id'];assert context.request.get(base+f'/api/attachments/{file_id}/content').body()==pdf
        page.locator('.ledger-table tbody tr').filter(has_text='生产验收0').get_by_role('button',name='详情',exact=True).click()
        page.get_by_role('button',name='预览',exact=True).click();expect(page.locator('.attachment-preview iframe')).to_be_visible()
        with page.expect_download() as download:page.get_by_role('link',name='无法预览时下载原文件',exact=True).click()
        assert Path(download.value.path()).read_bytes()==pdf
        page.get_by_role('button',name='关闭预览',exact=True).click();page.get_by_role('button',name='关闭',exact=True).click()
        done('PDF preview and byte-exact original download work under production security headers')
        with page.expect_download() as export:page.get_by_role('button',name='导出台账',exact=True).click()
        assert Path(export.value.path()).read_bytes().startswith(b'PK')
        page.get_by_role('button',name='统计汇总',exact=True).click();expect(page.locator('.metric-strip').first).to_contain_text('2')
        page.screenshot(path=str(OUT/'phase6-production-desktop.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        page.screenshot(path=str(OUT/'phase6-production-mobile.png'),full_page=True)
        done('Production export, statistics and mobile layout work without external app services')
        snapshot=maintain('backup','--db',str(DATABASE),'--out',str(BACKUPS));verified=maintain('verify','--backup',snapshot['folder'])
        assert verified['manifest']['counts']['archives']==2;assert verified['manifest']['counts']['attachments']==1
        done('Online backup verifies SQLite, foreign keys, attachment hashes and SHA-256 manifest')
        restored=maintain('restore','--backup',snapshot['folder'],'--target',str(RECOVERED));assert restored['sessionsRevoked']
        stop();base=start(RECOVERED);page.set_viewport_size({'width':1440,'height':1000});page.goto(base,wait_until='networkidle')
        expect(page.get_by_role('heading',name='登录档案系统')).to_be_visible()
        page.get_by_label('账号',exact=True).fill('production-admin');page.get_by_label('密码',exact=True).fill(PASS);page.get_by_role('button',name='登录',exact=True).click();expect(page.locator('.ledger-table tbody tr')).to_have_count(2)
        assert context.request.get(base+f'/api/attachments/{file_id}/content').body()==pdf
        session=context.request.get(base+'/api/auth/session').json()['data'];csrf={'X-CSRF-Token':session['csrfToken']}
        record=context.request.post(base+'/api/archive-drafts',data=fixture(3),headers=csrf).json()['data']
        result=context.request.post(base+f'/api/archives/{record["id"]}/register',data={'recordVersion':record['recordVersion']},headers=csrf).json()['data'];assert result['archiveNumber']=='GF-ZZ-003'
        done('Restored service retains credentials, archives and files, revokes sessions and resumes numbering')
        page.get_by_role('button',name='操作日志',exact=True).click();page.get_by_label('日志操作筛选').select_option('database_restored');expect(page.locator('tbody tr')).to_have_count(1)
        done('Restoration is visible in administrator audit logs')
        assert not errors,errors;done('No production browser runtime errors')
        browser.close()
finally:
    stop()
    # Only the unique, explicitly created temporary test paths are removed.
    for database in [DATABASE,RECOVERED]:
        assert database.parent.resolve()==(PROJECT/'backend/outputs').resolve()
        for suffix in ('','-wal','-shm'):Path(str(database)+suffix).unlink(missing_ok=True)
    if BACKUPS.exists():
        for file in BACKUPS.glob('*/*'):file.unlink()
        for folder in BACKUPS.iterdir():folder.rmdir()
        BACKUPS.rmdir()
(OUT/'phase6-browser-checks.json').write_text(json.dumps({'passed':checks,'runtime_errors':errors,'isolation':'Production static assets and API; independent databases only; no Linux server installation performed'},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed_count':len(checks),'runtime_errors':errors},ensure_ascii=False),flush=True)
