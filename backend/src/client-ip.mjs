import { isIP } from 'node:net';

export function clientIP(req,trustProxy=false){
  const peer=req.socket.remoteAddress||'';
  // Only a locally connected, explicitly trusted reverse proxy may supply this.
  if(trustProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)){
    const value=req.headers['x-real-ip'];
    if(typeof value==='string'&&isIP(value))return value;
  }
  return peer;
}
