"""Stable-directory updater: real Git repositories, mocked Docker and HTTP."""
import importlib.util,json,os,subprocess,tempfile,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('oldtests',Path(__file__).with_name('test_deploy.py'))
old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
GIT=r'''#!/usr/bin/env python3
import json,os,subprocess,sys
from pathlib import Path
a=sys.argv[1:];mode=os.environ.get('CASE','fallback')
with open(os.environ['CALLS'],'a') as f:f.write(json.dumps(['git',*a])+'\n')
if 'clone' in a or 'pull' in a:
 if mode=='git-failed':print('Git network failure',file=sys.stderr);sys.exit(7)
 for i,item in enumerate(a):
  if item.startswith('https://gitclone.com/'):
   print('Mirror unavailable',file=sys.stderr);sys.exit(7)
  if item.startswith('https://github.com/'):a[i]=os.environ['REMOTE']
sys.exit(subprocess.call(['/usr/bin/git',*a]))
'''

class UpdaterTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='archive-updater-');self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);self.base=self.root/'home';self.base.mkdir();self.bin=self.root/'bin';self.bin.mkdir()
  self.remote=self.root/'remote';self.remote.mkdir()
  def git(*args):subprocess.run(['/usr/bin/git','-C',str(self.remote),*args],check=True,capture_output=True)
  self.git=git;git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid')
  for name in ['Dockerfile','deploy/docker/compose.yaml','vendor/xlsx-0.20.3.tgz','value.txt']:
   file=self.remote/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('first')
  git('add','.');git('commit','-m','first')
  for name,code in [('git',GIT),('docker',old.MOCK),('curl',old.MOCK)]:
   file=self.bin/name;file.write_text(code);file.chmod(0o755)
  self.calls=self.root/'calls'
  self.env={**os.environ,'PATH':str(self.bin)+':'+os.environ['PATH'],'BASE_DIR':str(self.base),'REMOTE':str(self.remote),'CALLS':str(self.calls),'RETRIES':'1','HEALTH_TIMEOUT':'3','PUBLIC_URL':'http://10.20.30.40:8080'}
 def run_script(self,case='fallback'):
  result=subprocess.run(['bash',str(ROOT/'update-archive.sh')],env={**self.env,'CASE':case},capture_output=True,text=True,timeout=30)
  calls=[json.loads(l) for l in self.calls.read_text().splitlines()]
  return result,calls
 def test_first_clone_and_fast_forward_update(self):
  result,calls=self.run_script();self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertEqual((self.base/'f/value.txt').read_text(),'first');self.assertIn('网站链接：http://10.20.30.40:8080',result.stdout)
  (self.remote/'value.txt').write_text('second');self.git('add','.');self.git('commit','-m','second')
  result,calls=self.run_script();self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertEqual((self.base/'f/value.txt').read_text(),'second');self.assertTrue(any('pull' in c and '--ff-only' in c for c in calls))
  self.assertFalse(any('down' in c or 'prune' in c for c in calls))
 def test_local_changes_are_preserved(self):
  self.run_script();(self.base/'f/value.txt').write_text('local edit')
  result,calls=self.run_script();self.assertNotEqual(result.returncode,0);self.assertIn('未提交修改',result.stdout)
  self.assertEqual((self.base/'f/value.txt').read_text(),'local edit')
 def test_all_git_sources_fail_before_container_start(self):
  result,calls=self.run_script('git-failed');self.assertNotEqual(result.returncode,0)
  self.assertFalse(any(c[0]=='docker' and 'up' in c for c in calls));self.assertIn('前30行日志',result.stdout)
 def test_existing_non_git_directory_is_preserved(self):
  (self.base/'f').mkdir();(self.base/'f/keep').write_text('keep')
  result,calls=self.run_script();self.assertNotEqual(result.returncode,0);self.assertEqual((self.base/'f/keep').read_text(),'keep')
 def test_docker_build_and_start_failures_are_reported(self):
  for mode in ['daemon-failed','pull-failed','build-failed','up-failed']:
   with self.subTest(mode=mode):
    result,calls=self.run_script(mode);self.assertNotEqual(result.returncode,0,result.stdout);self.assertIn('失败日志目录',result.stdout);self.assertNotIn('部署完成',result.stdout)
 def test_health_failure_displays_first_30_lines(self):
  result,calls=self.run_script('health-failed');self.assertNotEqual(result.returncode,0)
  self.assertIn('container failure line 28',result.stdout);self.assertNotIn('container failure line 29',result.stdout)
 def test_web_failure_is_not_success(self):
  result,calls=self.run_script('url-failed');self.assertNotEqual(result.returncode,0);self.assertIn('website unavailable',result.stdout)

if __name__=='__main__':unittest.main(verbosity=2)
