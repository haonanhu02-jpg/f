import { statSync, realpathSync, createReadStream } from 'node:fs';
import path from 'node:path';

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webp':'image/webp','.woff2':'font/woff2'};
export function staticHandler(directory){
  if(!directory)return null;
  const root=realpathSync(directory);
  if(!statSync(path.join(root,'index.html')).isFile())throw new Error('Production index.html is missing. Build the frontend first.');
  // Only the build's public files are reachable; never fall back to the workspace.
  return (req,res,url)=>{
    if(url.pathname==='/api'||url.pathname.startsWith('/api/'))return false;
    const finish=(status,body='')=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body);};
    if(!['GET','HEAD'].includes(req.method)){finish(405,'Method not allowed');return true;}
    let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{finish(400,'Invalid path');return true;}
    if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').some(p=>p.startsWith('.')&&p!=='')){finish(404);return true;}
    const relative=decoded==='/'?'index.html':decoded.replace(/^\/+/,''),candidate=path.resolve(root,relative);
    if(!candidate.startsWith(root+path.sep)){finish(404);return true;}
    let file;
    try{file=realpathSync(candidate);if(!file.startsWith(root+path.sep)||!statSync(file).isFile())throw new Error('not public');}
    catch{finish(404);return true;}
    const ext=path.extname(file).toLowerCase();
    if(!types[ext]){finish(404);return true;}
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','same-origin');
    res.writeHead(200,{'Content-Type':types[ext],'Content-Length':statSync(file).size,'Cache-Control':relative.startsWith('assets/')?'public, max-age=31536000, immutable':'no-store'});
    if(req.method==='HEAD')res.end();else createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    return true;
  };
}
