"""Linux orchestration regression with mocked Git/Docker/network, no real deployment."""
import json,os,subprocess,tempfile,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
MOCK=r'''#!/usr/bin/env python3
import json,os,shutil,sys
from pathlib import Path
name=Path(sys.argv[0]).name;a=sys.argv[1:];mode=os.environ.get('CASE','fallback')
with open(os.environ['CALLS'],'a') as f:f.write(json.dumps([name,*a])+'\n')
def bad(s):print(s,file=sys.stderr);sys.exit(7)
if name=='git':
 if 'check-ref-format' in a:sys.exit(0)
 if 'ls-remote' in a:
  if mode=='empty':sys.exit(0)
  if mode=='upstream-down':bad('official source unavailable')
  print('a'*40+'\trefs/heads/main');sys.exit(0)
 if 'clone' in a:
  source=a[-2]
  if mode=='clone-failed' or 'github.com/haonanhu02-jpg/f.git'==source.removeprefix('https://'):bad('clone source unavailable')
  shutil.copytree(os.environ['FIXTURE'],a[-1]);sys.exit(0)
 if 'rev-parse' in a:print(('b' if mode=='mismatch' else 'a')*40);sys.exit(0)
elif name=='docker':
 if a[0]=='info':
  if mode=='daemon-failed':bad('Docker daemon not running')
  print('mock daemon');sys.exit(0)
 if a[0]=='version':print('mock Docker');sys.exit(0)
 if a[0]=='pull':
  if mode=='pull-failed' or a[-1].startswith('docker.io/'):bad('registry unreachable')
  print('pulled alternate image');sys.exit(0)
 if a[0]=='build':
  if mode=='build-failed' or 'NPM_REGISTRY=https://registry.npmjs.org' in a:bad('npm source unavailable')
  print('built using alternate npm registry');sys.exit(0)
 if a[0]=='ps':
  if os.environ.get('WITH_PREVIOUS')=='1':print('previous-container')
  sys.exit(0)
 if a[0]=='inspect':print('exited unhealthy' if mode=='health-failed' else 'running healthy');sys.exit(0)
 if a[0]=='exec':
  if mode=='backup-failed':bad('pre-upgrade backup failed')
  print('backup complete');sys.exit(0)
 if a[0]=='compose':
  if 'version' in a:print('Docker Compose version test');sys.exit(0)
  if 'config' in a:sys.exit(0)
  if 'up' in a:
   if mode=='up-failed':bad('compose port conflict')
   if mode=='upgrade-failed':
    marker=Path(os.environ['CALLS']+'.up')
    if not marker.exists():marker.write_text('attempted');bad('new image failed startup')
   print('started app');sys.exit(0)
  if 'ps' in a:
   if '--quiet' in a:print('container-id')
   else:print('mock app status')
   sys.exit(0)
  if 'logs' in a:
   for i in range(50):print('container failure line '+str(i+1))
   sys.exit(0)
elif name=='curl':
 if mode=='url-failed':bad('website unavailable')
 if '--output' in a:Path(a[a.index('--output')+1]).write_text('<div id="root"></div><script src="/assets/app.js"></script>')
 else:print('{"data":{"ok":true,"schemaVersion":3}}')
 sys.exit(0)
bad('Unexpected mock command: '+name+' '+str(a))
'''

class DeploymentTests(unittest.TestCase):
 def run_case(self,mode,extra=None):
  directory=tempfile.TemporaryDirectory(prefix='archive-deploy-test-');self.addCleanup(directory.cleanup)
  root=Path(directory.name);bin=root/'bin';bin.mkdir();fixture=root/'fixture';fixture.mkdir()
  for name in ['Dockerfile','deploy/docker/compose.yaml','deploy/docker/install-dependencies.mjs','vendor/xlsx-0.20.3.tgz','frontend/package-lock.json','backend/package-lock.json']:
   file=fixture/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('fixture')
  for name in ['git','docker','curl']:
   file=bin/name;file.write_text(MOCK);file.chmod(0o755)
  calls=root/'calls.jsonl';target=root/'deployment'
  if (extra or {}).get('WITH_PREVIOUS')=='1':
   previous=target/'releases/previous';(previous/'source/deploy/docker').mkdir(parents=True)
   (previous/'runtime.env').write_text('ARCHIVE_IMAGE=previous:image\n');(previous/'source/deploy/docker/compose.yaml').write_text('services: {}')
   (target/'current').symlink_to(previous)
  env={**os.environ,'PATH':str(bin)+os.pathsep+os.environ['PATH'],'CASE':mode,'CALLS':str(calls),'FIXTURE':str(fixture),'DEPLOY_DIR':str(target),'PUBLIC_URL':'http://10.20.30.40:8080','RETRIES':'1','HEALTH_TIMEOUT':'3',**(extra or {})}
  result=subprocess.run(['bash',str(ROOT/'deploy.sh')],env=env,capture_output=True,text=True,timeout=30)
  logs=list((target/'logs').glob('*'));self.assertEqual(len(logs),1)
  metadata=json.loads((logs[0]/'result.json').read_text())
  return result,metadata,logs[0],[json.loads(l) for l in calls.read_text().splitlines()]

 def test_success_switches_code_image_and_npm_sources(self):
  result,data,log,calls=self.run_case('fallback')
  self.assertEqual(result.returncode,0,result.stdout+result.stderr);self.assertTrue(data['success'])
  self.assertIn('网站链接：http://10.20.30.40:8080',result.stdout)
  self.assertEqual(sum(c[0]=='git' and 'clone' in c for c in calls),2)
  self.assertEqual(sum(c[0]=='docker' and c[1]=='pull' for c in calls),2)
  self.assertEqual(sum(c[0]=='docker' and c[1]=='build' for c in calls),2)
  self.assertTrue((log.parent.parent/'current/runtime.env').exists())

 def test_empty_upstream_is_not_treated_as_success(self):
  result,data,log,calls=self.run_case('empty')
  self.assertNotEqual(result.returncode,0);self.assertFalse(data['success']);self.assertIn('仓库为空',result.stdout)
  self.assertFalse(any(c[0]=='docker' and c[1]=='build' for c in calls))

 def test_mirror_commit_mismatch_is_rejected(self):
  result,data,log,calls=self.run_case('mismatch')
  self.assertNotEqual(result.returncode,0);self.assertIn('SHA不匹配',result.stdout)

 def test_clone_pull_build_and_daemon_failures_report_logs(self):
  for case in ['clone-failed','pull-failed','build-failed','daemon-failed']:
   with self.subTest(case=case):
    result,data,log,calls=self.run_case(case)
    self.assertNotEqual(result.returncode,0);self.assertFalse(data['success']);self.assertIn('失败日志目录：'+str(log),result.stdout)
    self.assertIn('前30行日志',result.stdout);self.assertTrue((log/'failure.log').exists());self.assertNotIn('部署成功',result.stdout)

 def test_health_failure_displays_exactly_first_30_log_lines(self):
  result,data,log,calls=self.run_case('health-failed')
  self.assertNotEqual(result.returncode,0);self.assertIn('container failure line 28',result.stdout);self.assertNotIn('container failure line 29',result.stdout)
  expected='\n'.join((log/'failure.log').read_text().splitlines()[:30])
  self.assertIn(expected,result.stdout);self.assertTrue((log/'container.log').exists())

 def test_startup_and_url_failures_are_not_success(self):
  for case in ['up-failed','url-failed']:
   with self.subTest(case=case):
    result,data,log,calls=self.run_case(case);self.assertNotEqual(result.returncode,0);self.assertFalse(data['success']);self.assertNotIn('部署成功',result.stdout)
    self.assertIn('compose port conflict' if case=='up-failed' else 'website unavailable',result.stdout)

 def test_upstream_down_accepts_configured_mirror_and_records_commit(self):
  result,data,log,calls=self.run_case('upstream-down')
  self.assertEqual(result.returncode,0,result.stdout+result.stderr);self.assertEqual(data['commit'],'a'*40)

 def test_upgrade_backs_up_before_replacement_and_keeps_data_volumes(self):
  result,data,log,calls=self.run_case('fallback',{'WITH_PREVIOUS':'1'})
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  backup=next(i for i,c in enumerate(calls) if c[0]=='docker' and c[1]=='exec')
  start=next(i for i,c in enumerate(calls) if c[0]=='docker' and 'up' in c)
  self.assertLess(backup,start)
  self.assertFalse(any('down' in c or 'prune' in c or 'volume' in c for c in calls))

 def test_failed_upgrade_restarts_previous_version_and_reports_failure(self):
  result,data,log,calls=self.run_case('upgrade-failed',{'WITH_PREVIOUS':'1'})
  self.assertNotEqual(result.returncode,0);self.assertFalse(data['success']);self.assertTrue((log/'rollback.log').exists())
  self.assertEqual((log.parent.parent/'current').resolve().name,'previous')
  self.assertEqual(sum(c[0]=='docker' and 'up' in c for c in calls),2)

 def test_backup_failure_stops_before_replacing_running_service(self):
  result,data,log,calls=self.run_case('backup-failed',{'WITH_PREVIOUS':'1'})
  self.assertNotEqual(result.returncode,0);self.assertEqual(data['stage'],'升级前备份')
  self.assertFalse(any(c[0]=='docker' and 'up' in c for c in calls))

if __name__=='__main__':unittest.main(verbosity=2)
