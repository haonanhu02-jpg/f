// Run after server installation; no accounts, cookies or writes are created.
const base=process.argv[2];
if(!base||!/^https?:\/\//.test(base))throw new Error('Usage: node check-deployment.mjs https://LAN-HOST');
const root=new URL(base);
for(const [pathname,expected]of [['/',200],['/api/health',200],['/api/auth/session',200],['/api/archives',401],['/api/security/users',401]]){
  const response=await fetch(new URL(pathname,root));
  if(response.status!==expected)throw new Error(`${pathname}: expected ${expected}, received ${response.status}`);
  if(pathname==='/api/health'&&(await response.json()).data.schemaVersion!==3)throw new Error('Wrong database version');
  if(pathname==='/'){
    const html=await response.text();
    const asset=html.match(/src="([^\"]+\.js)"/);
    if(!asset||!(await fetch(new URL(asset[1],root))).ok)throw new Error('Production frontend asset is missing');
    if(html.includes('/@vite/client'))throw new Error('Development frontend detected');
  }
  console.log(`PASS ${pathname}: ${expected}`);
}
