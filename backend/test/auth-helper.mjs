const sessions=new Map();
const credentials={username:'regression-admin',displayName:'回归管理员',password:'Regression-test-password-2026'};
export async function authFetch(input,options={},retry=true){
  const url=new URL(input),base=url.origin;
  let session=sessions.get(base);
  if(!session){
    let response=await globalThis.fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
    if(response.status===409)response=await globalThis.fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:credentials.username,password:credentials.password})});
    const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));
    session={cookie:response.headers.get('set-cookie').split(';')[0],csrf:result.data.csrfToken};sessions.set(base,session);
  }
  const headers=new Headers(options.headers);headers.set('Cookie',session.cookie);headers.set('X-CSRF-Token',session.csrf);
  const response=await globalThis.fetch(input,{...options,headers});
  if(response.status===401&&retry){sessions.delete(base);return authFetch(input,options,false);}return response;
}
