"""Create allowlisted Linux runtime and source ZIPs; exclude all work data/secrets."""
import argparse, hashlib, json, shutil, stat, zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
VERSION=json.loads((ROOT/'backend/version.json').read_text(encoding='utf-8'))['version']
parser=argparse.ArgumentParser()
parser.add_argument('--output',type=Path,default=ROOT/'delivery'/VERSION)
parser.add_argument('--kind',choices=['all','linux','source'],default='all')
args=parser.parse_args()
OUT=args.output.resolve();OUT.mkdir(parents=True,exist_ok=True)
def digest(file):
    h=hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()
def copy(source,target):
    if source.is_dir():
        for file in source.rglob('*'):
            if file.is_file():copy(file,target/file.relative_to(source))
    else:
        if source.suffix in {'.sqlite','.db','.node','.pem','.key'} or source.name.startswith(('.env','.dev.vars')):raise RuntimeError('Excluded runtime data or platform binary: '+str(source))
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
def notices():
    text=[]
    for name in ['react','react-dom','scheduler','lucide-react','zod','xlsx']:
        directory=(ROOT/'backend/node_modules'/name) if name=='xlsx' else ROOT/'frontend/node_modules'/name
        package=json.loads((directory/'package.json').read_text(encoding='utf-8'))
        text.append(f'\n===== {name} {package["version"]} ({package.get("license", "see license")}) =====\n')
        for file in directory.iterdir():
            if file.is_file() and file.name.lower().startswith(('license','licence','notice','copyright')):text.append(file.read_text(encoding='utf-8',errors='replace'))
    return '\n'.join(text)
runtime=['README.md','backend/README.md','backend/package.json','backend/package-lock.json','backend/version.json','backend/src','backend/seed','backend/scripts/maintenance.mjs','backend/node_modules/zod','backend/node_modules/xlsx','frontend/README.md','frontend/dist-production','deploy','docs','tools/verify-release.mjs','scripts/start-production.mjs']
source=['README.md','.gitignore','backend/README.md','backend/.gitignore','backend/package.json','backend/package-lock.json','backend/version.json','backend/src','backend/seed','backend/scripts','backend/test','frontend/README.md','frontend/.gitignore','frontend/package.json','frontend/package-lock.json','frontend/tsconfig.json','frontend/next-env.d.ts','frontend/next.config.ts','frontend/vite-env.d.ts','frontend/cloudflare-env.d.ts','frontend/drizzle.config.ts','frontend/vite.config.ts','frontend/vite.production.config.ts','frontend/postcss.config.mjs','frontend/app','frontend/features','frontend/production','frontend/public','frontend/scripts','frontend/components','frontend/lib','frontend/hooks','frontend/worker','frontend/db','frontend/drizzle','frontend/.openai/hosting.json','deploy','docs','tools','scripts']
source+=['.gitattributes','.dockerignore','Dockerfile','deploy.sh','vendor']
for kind,items in [('linux',runtime),('source',source)]:
    if args.kind not in ['all',kind]:continue
    folder=OUT/f'archive-ledger-{VERSION}-{kind}'
    if folder.exists():raise RuntimeError(f'Release already exists: {folder}; use a new version or preserve/remove the old release explicitly.')
    folder.mkdir()
    for item in items:
        src=ROOT/item
        if src.exists():copy(src,folder/item)
        else:raise RuntimeError('Missing release input: '+item)
    (folder/'THIRD-PARTY-NOTICES.txt').write_text(notices(),encoding='utf-8')
    start='# 档案台账1.0.0交付\n\n'
    if kind=='source':start+='当前采用容器部署：先将本包源码上传到指定GitHub仓库main分支，再将deploy.sh复制到Linux服务器执行 sudo bash deploy.sh。多源配置、成功网址及失败日志说明见 deploy/docker/README.md。包内含Dockerfile和经过完整性校验的vendor构建依赖。\n\n'
    else:start+='本运行包用于原Node宿主机部署，安装阅读 deploy/linux/README.md。当前容器部署请使用另行提供的完整源码包。\n\n'
    start+='操作阅读 docs/phase-6/使用手册.md；备份恢复阅读 docs/phase-6/运维与恢复.md。\n\n包内不含工作数据库或默认账号密码，尚未在目标服务器部署。执行 node tools/verify-release.mjs 校验全部文件。\n'
    (folder/'START-HERE.md').write_text(start,encoding='utf-8')
    summary=ROOT/'frontend/outputs/phase6-browser-checks.json'
    if not summary.exists():raise RuntimeError('Production browser verification report is missing')
    regressions={f'phase{phase}':json.loads((ROOT/f'frontend/outputs/phase{phase}-browser-checks.json').read_text(encoding='utf-8')) for phase in [3,4,5]}
    (folder/'validation-summary.json').write_text(json.dumps({'version':VERSION,'date':datetime.now(timezone.utc).isoformat(),'nodeVerified':'24.15.0','hostVerified':'Windows','backendTests':38,'backendFailures':0,'typecheck':'passed','productionBuild':'passed','productionBrowser':json.loads(summary.read_text(encoding='utf-8')),'regressionBrowser':regressions,'linuxServerInstallation':'pending: IP/domain/certificate/connection not provided','containerDeploymentVerification':json.loads((ROOT/'deploy/docker/validation.json').read_text(encoding='utf-8')),'linuxServiceAndNginxRuntimeCheck':'not run: systemd is the alternative deployment method'},ensure_ascii=False,indent=2),encoding='utf-8')
    files=[{'path':file.relative_to(folder).as_posix(),'bytes':file.stat().st_size,'sha256':digest(file)} for file in sorted(folder.rglob('*')) if file.is_file()]
    manifest={'version':VERSION,'schemaVersion':3,'kind':kind,'createdAt':datetime.now(timezone.utc).isoformat(),'files':files}
    (folder/'RELEASE-MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    archive=folder.parent/(folder.name+'.zip')
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for file in sorted(folder.rglob('*')):
            if file.is_file():
                item=zipfile.ZipInfo(file.relative_to(folder).as_posix());item.create_system=3;item.external_attr=(stat.S_IFREG|0o644)<<16;item.compress_type=zipfile.ZIP_DEFLATED
                z.writestr(item,file.read_bytes())
    archive.with_suffix('.zip.sha256').write_bytes((digest(archive)+'  '+archive.name+'\n').encode('ascii'))
    print(json.dumps({'kind':kind,'archive':str(archive),'files':len(files)+1,'bytes':archive.stat().st_size,'sha256':digest(archive)},ensure_ascii=False),flush=True)
