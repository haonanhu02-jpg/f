"""Exercise production buttons over ordinary LAN-style HTTP, on an isolated DB."""
import json,os,re,socket,subprocess,uuid
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1];PROJECT=ROOT.parent;OUT=ROOT/'outputs';OUT.mkdir(exist_ok=True)
DB=PROJECT/'backend/outputs'/('buttons-'+str(uuid.uuid4())+'.sqlite')
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
BASE=f'http://archive.test:{port}';PASS='Buttons-fixture-password-2026';checks=[];errors=[]
process=subprocess.Popen(['node','src/server.mjs'],cwd=PROJECT/'backend',env={**os.environ,'PORT':str(port),'ARCHIVE_DB_PATH':str(DB),'ARCHIVE_STATIC_DIR':str(ROOT/'dist-production'),'ARCHIVE_ALLOWED_ORIGINS':BASE},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
assert 'Archive API' in process.stdout.readline()
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path=str(Path.home()/'AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe'),headless=True,args=['--host-resolver-rules=MAP archive.test 127.0.0.1','--no-proxy-server'])
  context=browser.new_context(viewport={'width':1440,'height':1000});page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(BASE,wait_until='networkidle');assert page.evaluate('window.isSecureContext') is False
  page.get_by_label('账号',exact=True).fill('buttons-admin');page.get_by_label('姓名',exact=True).fill('按钮验收');page.get_by_label('密码',exact=True).fill(PASS);page.get_by_label('再次输入密码',exact=True).fill(PASS);page.get_by_role('button',name='创建管理员并登录').click()
  expect(page.get_by_role('heading',name='档案台账',exact=True)).to_be_visible()
  def click(name,scope=None):(scope or page).get_by_role('button',name=name,exact=True).first.click()
  def done(label):checks.append(label);print('PASS:',label,flush=True)
  click('新增档案');expect(page.get_by_role('heading',name='新增档案',exact=True)).to_be_visible(timeout=5000)
  page.get_by_label('档案大类',exact=False).select_option('qualification');page.get_by_label('所属公司',exact=False).select_option('company-4');page.get_by_label('证件名称',exact=False).fill('按钮验收档案')
  click('保存草稿');expect(page.locator('.ledger-table tbody tr')).to_have_count(1)
  done('HTTP LAN: new archive and save draft')
  click('详情');click('关闭');click('编辑');page.get_by_label('存放位置',exact=False).fill('按钮测试柜');click('保存草稿')
  page.once('dialog',lambda d:d.accept());click('入账');expect(page.locator('.ledger-table')).to_contain_text('GF-ZZ-001')
  click('详情');png=bytes.fromhex('89504e470d0a1a0a')+b'button-fixture'
  page.get_by_label('上传扫描附件').set_input_files({'name':'scan.png','mimeType':'image/png','buffer':png});expect(page.locator('.attachment-list li')).to_have_count(1)
  click('预览');expect(page.locator('.attachment-preview img')).to_be_visible();click('关闭预览')
  with page.expect_download():page.get_by_role('link',name='下载',exact=True).click()
  click('关闭');click('作废');page.get_by_label('作废原因',exact=False).fill('按钮验收作废');click('确认作废');expect(page.locator('.ledger-table')).to_contain_text('已作废')
  done('Details/edit/register/attachment upload-preview-download/void')
  click('高级筛选');click('收起筛选');click('重置');click('查询');click('刷新')
  with page.expect_download():click('导出台账')
  click('导入 Excel')
  with page.expect_download() as dl:click('下载导入模板')
  page.get_by_label('选择Excel导入文件').set_input_files(dl.value.path());click('预览校验');expect(page.get_by_role('alert')).to_be_visible();click('关闭')
  done('Search/reset/refresh/export/import dialog/template/validation')
  click('公司与部门');click('新增公司');dialog=page.get_by_role('dialog');page.get_by_label('公司全称',exact=False).fill('按钮验收公司');page.get_by_label('公司编码',exact=False).fill('BT');click('保存公司');expect(page.get_by_role('dialog')).to_have_count(0)
  row=page.locator('tbody tr').filter(has_text='按钮验收公司');click('编辑',row);page.get_by_label('公司简称',exact=True).fill('按钮公司');click('保存公司');click('停用',row);expect(row).to_contain_text('已停用');click('启用',row)
  page.get_by_role('tab',name='部门目录').click();click('新增部门');page.get_by_label('部门名称',exact=False).fill('按钮验收部门');page.get_by_role('dialog').get_by_label('所属公司',exact=False).select_option('company-4');click('保存部门');expect(page.get_by_role('dialog')).to_have_count(0)
  row=page.locator('tbody tr').filter(has_text='按钮验收部门');click('编辑',row);click('取消');click('停用',row);expect(row).to_contain_text('已停用');click('启用',row)
  done('HTTP LAN: company and department create/edit/enable/disable')
  click('分类与编码');click('新增分类');page.get_by_label('分类编码',exact=False).fill('99');page.get_by_label('分类名称',exact=False).fill('按钮验收分类');click('保存分类');expect(page.get_by_role('dialog')).to_have_count(0)
  row=page.locator('tbody tr').filter(has_text='按钮验收分类');click('编辑',row);click('取消');click('停用',row);expect(row).to_contain_text('已停用');click('启用',row)
  done('HTTP LAN: category create/edit/enable/disable')
  click('权限管理');click('新增账号');click('取消');click('秘密等级字典');click('新增秘密等级');page.get_by_label('等级名称',exact=False).fill('按钮验收等级');click('保存秘密等级');expect(page.get_by_role('dialog')).to_have_count(0)
  click('到期提醒');expect(page.get_by_role('heading',name='到期提醒',exact=True)).to_be_visible();click('统计汇总');expect(page.get_by_role('heading',name='统计汇总',exact=True)).to_be_visible();click('操作日志');expect(page.locator('tbody tr').first).to_be_visible()
  click('修改密码');click('取消');click('档案台账');page.screenshot(path=str(OUT/'buttons-http-desktop.png'),full_page=True)
  page.set_viewport_size({'width':390,'height':844});click('新增档案');expect(page.get_by_role('heading',name='新增档案',exact=True)).to_be_visible();click('返回档案台账');click('退出');expect(page.get_by_role('heading',name='登录档案系统')).to_be_visible()
  done('Security/levels/reminders/statistics/audit/password dialog/mobile navigation/logout')
  assert not errors,errors;done('No uncaught browser exceptions')
  browser.close()
finally:
 process.terminate();process.wait(timeout=15)
 for suffix in ('','-wal','-shm'):Path(str(DB)+suffix).unlink(missing_ok=True)
 (OUT/'buttons-checks.json').write_text(json.dumps({'passed':checks,'errors':errors,'origin':BASE,'secureContext':False,'database':'isolated'},ensure_ascii=False,indent=2),encoding='utf-8')
