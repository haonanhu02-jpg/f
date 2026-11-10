"""Phase4 browser acceptance. Uses its own temporary API/database and fixture files."""
import json
import os
import re
import subprocess
import uuid
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
PROJECT=ROOT.parent
OUT=ROOT/'outputs'
OUT.mkdir(exist_ok=True)
fixtures=OUT/'phase4-fixtures'
subprocess.run(['node','scripts/phase4-fixtures.mjs',str(fixtures)],cwd=PROJECT/'backend',check=True)
database=PROJECT/'backend/outputs'/('browser-phase4-'+str(uuid.uuid4())+'.sqlite')
database.parent.mkdir(exist_ok=True)
process=subprocess.Popen(['node','src/server.mjs'],cwd=PROJECT/'backend',env={**os.environ,'PORT':'0','ARCHIVE_DB_PATH':str(database)},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
line=process.stdout.readline()
match=re.search(r'http://127\.0\.0\.1:\d+',line)
if not match:
    process.terminate()
    raise RuntimeError('Isolated API did not start: '+line)
API=match.group(0)
checks=[]
errors=[]
def done(message):
    checks.append(message)
    print('PASS:',message,flush=True)
try:
    with sync_playwright() as p:
        executable=Path.home()/'AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe'
        if not executable.exists():
            executable=Path.home()/'AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe'
        browser=p.chromium.launch(executable_path=str(executable),headless=True)
        context=browser.new_context(viewport={'width':1440,'height':1000},locale='zh-CN',accept_downloads=True)
        def api_route(route):
            response=route.fetch(url=API+'/api'+route.request.url.split('/api',1)[1])
            route.fulfill(response=response)
        context.request.post(API+'/api/auth/setup',data=dict(username='browser-admin',displayName='浏览器验收管理员',password='Browser-acceptance-password-2026'))
        context.route('**/api/**',api_route)
        page=context.new_page()
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:5173',wait_until='networkidle')
        page.get_by_role('button',name='导入 Excel',exact=True).click()
        with page.expect_download() as download:
            page.get_by_role('button',name='下载导入模板',exact=True).click()
        download.value.save_as(OUT/'phase4-template.xlsx')
        assert zipfile.is_zipfile(OUT/'phase4-template.xlsx')
        page.get_by_label('选择Excel导入文件').set_input_files(str(fixtures/'mixed.xlsx'))
        page.get_by_role('button',name='预览校验',exact=True).click()
        expect(page.get_by_role('status').filter(has_text='可导入2条')).to_be_visible()
        expect(page.get_by_role('status').filter(has_text='重复跳过1条，失败1条')).to_be_visible()
        assert context.request.get(API+'/api/archives').json()['data']['total']==0
        done('Template download and row-level preview without writing archive records')
        page.get_by_role('button',name='确认导入可用2行').click()
        expect(page.get_by_role('status').filter(has_text='新增2条草稿')).to_be_visible()
        with page.expect_download() as report:
            page.get_by_role('button',name='下载结果报告',exact=True).click()
        report.value.save_as(OUT/'phase4-import-report.xlsx')
        assert zipfile.is_zipfile(OUT/'phase4-import-report.xlsx')
        page.get_by_role('button',name='关闭',exact=True).click()
        expect(page.locator('.ledger-table tbody tr')).to_have_count(2)
        assert context.request.get(API+'/api/archives').json()['data']['stats']['registered']==0
        done('Confirmed partial import creates drafts and provides a downloadable result report')
        page.get_by_placeholder('档案名称 / 档号 / 证书编号').fill('第四阶段验收证照')
        page.get_by_role('button',name='查询',exact=True).click()
        expect(page.locator('.ledger-table tbody tr')).to_have_count(1)
        page.get_by_role('button',name='详情',exact=True).click()
        dialog=page.get_by_role('dialog')
        expect(dialog.get_by_text('00123',exact=True)).to_be_visible()
        scan_quantity=dialog.locator('dt').filter(has_text='扫描件数量（份）').locator('..').locator('dd')
        expect(scan_quantity).to_have_text('3')
        png=(fixtures/'scan.png').read_bytes()
        page.get_by_label('上传扫描附件').set_input_files([{'name':'中文扫描件.png','mimeType':'image/png','buffer':png},{'name':'重复文件.png','mimeType':'image/png','buffer':png}])
        expect(page.get_by_role('status').filter(has_text='新增1个文件，重复跳过1个')).to_be_visible()
        expect(page.locator('.attachment-list li')).to_have_count(1)
        expect(scan_quantity).to_have_text('3')
        page.get_by_role('button',name='预览',exact=True).click()
        image=page.locator('.attachment-preview img')
        expect(image).to_be_visible()
        assert image.evaluate('(image)=>image.complete && image.naturalWidth>0')
        with page.expect_download() as image_download:
            page.locator('.attachment-list').get_by_role('link',name='下载',exact=True).click()
        assert image_download.value.suggested_filename=='中文扫描件.png'
        assert Path(image_download.value.path()).read_bytes()==png
        done('Image upload, content dedup, real image preview and byte-exact Unicode download')
        page.get_by_role('button',name='关闭预览',exact=True).click()
        page.get_by_label('上传扫描附件').set_input_files({'name':'验收扫描.pdf','mimeType':'application/pdf','buffer':(fixtures/'preview.pdf').read_bytes()})
        expect(page.locator('.attachment-list li')).to_have_count(2)
        pdf_row=page.locator('.attachment-list li').filter(has_text='验收扫描.pdf')
        pdf_row.get_by_role('button',name='预览',exact=True).click()
        expect(page.locator('.attachment-preview iframe')).to_be_visible()
        page.locator('.attachment-preview iframe').scroll_into_view_if_needed()
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUT/'phase4-attachments-desktop.png'),full_page=True)
        with page.expect_download() as pdf_download:
            pdf_row.get_by_role('link',name='下载',exact=True).click()
        assert Path(pdf_download.value.path()).read_bytes()==(fixtures/'preview.pdf').read_bytes()
        expect(scan_quantity).to_have_text('3')
        done('PDF iframe preview and download; file count remains separate from scan-copy count')
        page.get_by_label('上传扫描附件').set_input_files({'name':'伪装.pdf','mimeType':'application/pdf','buffer':b'<html>not a PDF</html>'})
        expect(page.get_by_role('alert').filter(has_text='扩展名一致')).to_be_visible()
        expect(page.locator('.attachment-list li')).to_have_count(2)
        page.get_by_role('button',name='关闭',exact=True).click()
        page.reload(wait_until='networkidle')
        expect(page.locator('.ledger-table tbody tr')).to_have_count(2)
        page.get_by_placeholder('档案名称 / 档号 / 证书编号').fill('第四阶段验收证照')
        page.get_by_role('button',name='查询',exact=True).click()
        expect(page.locator('.ledger-table tbody tr')).to_have_count(1)
        page.get_by_role('button',name='详情',exact=True).click()
        expect(page.locator('.attachment-list li')).to_have_count(2)
        page.get_by_role('button',name='关闭',exact=True).click()
        done('Rejected attachment does not affect prior files; attachments persist across reload')
        with page.expect_download() as export:
            page.get_by_role('button',name='导出台账',exact=True).click()
        export.value.save_as(OUT/'phase4-filtered-export.xlsx')
        output=subprocess.check_output(['node','--input-type=module','-e',"import * as X from 'xlsx';import{readFileSync}from'node:fs';const b=X.read(readFileSync(process.argv[1]),{type:'buffer'});const r=X.utils.sheet_to_json(b.Sheets[b.SheetNames[0]],{defval:null});console.log(JSON.stringify(r));",str(OUT/'phase4-filtered-export.xlsx')],cwd=PROJECT/'backend',text=True,encoding='utf-8')
        rows=json.loads(output)
        assert len(rows)==1 and rows[0]['证书编号']=='00123' and rows[0]['原件数量（份）']==0 and rows[0]['附件文件数']==2 and rows[0]['扫描件数量（份）']==3
        done('Filtered Excel export preserves identifiers, zero/null, file counts and all business fields')
        page.get_by_role('button',name='导入 Excel',exact=True).click()
        page.get_by_label('选择Excel导入文件').set_input_files(str(fixtures/'mixed.xlsx'))
        page.get_by_role('button',name='预览校验',exact=True).click()
        expect(page.get_by_role('status').filter(has_text='可导入0条')).to_be_visible()
        expect(page.get_by_role('status').filter(has_text='重复跳过3条')).to_be_visible()
        page.screenshot(path=str(OUT/'phase4-import-preview.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        page.screenshot(path=str(OUT/'phase4-import-mobile.png'),full_page=True)
        page.set_viewport_size({'width':320,'height':720})
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        done('Re-import duplicate detection and responsive import dialog')
        assert not errors,errors
        done('No browser runtime errors')
        browser.close()
finally:
    process.terminate()
    process.wait(timeout=15)
    assert database.parent.resolve()==(PROJECT/'backend/outputs').resolve()
    for suffix in ('','-wal','-shm'):
        Path(str(database)+suffix).unlink(missing_ok=True)
(OUT/'phase4-browser-checks.json').write_text(json.dumps({'passed':checks,'runtime_errors':errors,'isolation':'Dedicated ephemeral database; live workspace untouched'},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed_count':len(checks),'runtime_errors':errors},ensure_ascii=False),flush=True)
