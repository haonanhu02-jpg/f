import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile,stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(process.argv[2]||fileURLToPath(new URL('..',import.meta.url)));
const manifest=JSON.parse(await readFile(path.join(root,'RELEASE-MANIFEST.json'),'utf8'));
let checked=0;
for(const file of manifest.files){
  const absolute=path.resolve(root,file.path);
  if(!absolute.startsWith(root+path.sep))throw new Error('Invalid manifest path');
  const hash=createHash('sha256');for await(const chunk of createReadStream(absolute))hash.update(chunk);
  if((await stat(absolute)).size!==file.bytes||hash.digest('hex')!==file.sha256)throw new Error(`File verification failed: ${file.path}`);
  checked++;
}
console.log(JSON.stringify({version:manifest.version,kind:manifest.kind,checked,result:'passed'}));
