import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const registry=process.env.NPM_REGISTRY||'https://registry.npmjs.org';
if(!/^https:\/\/[^\s@]+\/?$/.test(registry))throw new Error('An HTTPS npm registry without credentials is required.');
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
for(const pkg of Object.values(lock.packages||{})){
  if(pkg.resolved?.startsWith('https://registry.npmjs.org/'))pkg.resolved=registry.replace(/\/$/,'')+'/'+pkg.resolved.slice('https://registry.npmjs.org/'.length);
}
const backend=process.argv[2]==='backend';
if(backend){
  const tarball='/vendor/xlsx-0.20.3.tgz';
  const xlsx=lock.packages['node_modules/xlsx'];
  const actual='sha512-'+createHash('sha512').update(readFileSync(tarball)).digest('base64');
  if(xlsx.integrity!==actual)throw new Error('Vendored SheetJS tarball does not match the original lockfile integrity.');
  const pkg=JSON.parse(readFileSync('package.json','utf8'));
  pkg.dependencies.xlsx='file:'+tarball;lock.packages[''].dependencies.xlsx='file:'+tarball;xlsx.resolved='file:'+tarball;
  writeFileSync('package.json',JSON.stringify(pkg,null,2));
}
writeFileSync('package-lock.json',JSON.stringify(lock,null,2));
const result=spawnSync('npm',['ci',...(backend?['--omit=dev','--ignore-scripts']:['--include=dev']),'--no-audit','--no-fund','--registry',registry],{stdio:'inherit'});
if(result.error)throw result.error;
process.exit(result.status??1);
