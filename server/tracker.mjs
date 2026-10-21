import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {config} from './config.mjs';
import {database,one} from './db.mjs';
import {verify,bots} from './security.mjs';
import {refreshSettings} from './settings.mjs';
const c=config(),db=database(c.databaseURL),groups=new Map(),attempts=new Map();
const http=createServer((req,res)=>{res.writeHead(404);res.end();});
const ws=new WebSocketServer({noServer:true,maxPayload:256*1024,perMessageDeflate:false});
http.on('upgrade',async(req,socket,head)=>{
  const reject=()=>{socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();};
  try {
    const ip=req.socket.remoteAddress;
    if(!c.p2p)return reject();
    const n=attempts.get(ip)||0; attempts.set(ip,n+1); if(n>=30) return reject();
    if(bots.test(req.headers['user-agent']||'')) return reject();
    const url=new URL(req.url,'http://tracker'); if(url.pathname!=='/tracker') return reject();
    const p=verify(url.searchParams.get('ticket'),c.tokenSecret,'peer');
    if(p.role==='seed') { if(req.headers.origin) return reject(); }
    else {
      if(req.headers.origin!==c.origin) return reject();
      const session=await one(db,'SELECT id FROM peer_sessions WHERE id=$1 AND album_id=$2 AND expires_at>now()',[p.session,p.albumId]);
      if(!session || !await active(p.albumId)) return reject();
    }
    ws.handleUpgrade(req,socket,head,s=>ws.emit('connection',s,p));
  } catch {reject();}
});
function send(socket,data) {if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));}
async function active(id,seed=false) {
  if(!c.p2p)return null;
  return one(db,`SELECT a.id FROM albums a JOIN users u ON u.id=a.owner_id WHERE a.id=$1 AND a.status IN (${seed?"'processing','published'":"'published'"}) AND a.expires_at>now() AND u.status='active'`,[id]);
}
ws.on('connection',(socket,p)=>{
  let group=groups.get(p.infoHash); if(!group){group=new Map();groups.set(p.infoHash,group);}
  if(p.role==='receiver' && [...group.values()].filter(s=>s.permission.role==='receiver').length>=c.maxPeers) return socket.close(1008,'Capacity');
  socket.permission=p; let peerId=null,rate=0;
  const deadline=setTimeout(()=>socket.close(1008,'Ticket expired'),Math.max(1,p.exp*1000-Date.now()));
  socket.on('message',async raw=>{
    try {
      if(++rate>120) throw new Error('rate');
      const m=JSON.parse(raw.toString());
      if(m.action!=='announce' || typeof m.info_hash!=='string' || Buffer.from(m.info_hash,'binary').toString('hex')!==p.infoHash || typeof m.peer_id!=='string' || Buffer.from(m.peer_id,'binary').length!==20) throw new Error('Invalid announce');
      if(peerId && peerId!==m.peer_id) throw new Error('Peer changed');
      if(!await active(p.albumId,p.role==='seed')) throw new Error('Revoked');
      if(!peerId){
        peerId=m.peer_id;
        const existing=group.get(peerId); if(existing && existing!==socket) throw new Error('Duplicate peer');
        if(p.role==='receiver') {
          const bound=await one(db,'UPDATE peer_sessions SET peer_id=$1 WHERE id=$2 AND (peer_id IS NULL OR peer_id=$1) AND expires_at>now() RETURNING id',[Buffer.from(peerId,'binary').toString('hex'),p.session]);
          if(!bound) throw new Error('Session expired');
        }
        group.set(peerId,socket);
      }
      if(m.event==='stopped') return socket.close();
      const seeds=[...group.entries()].filter(([,s])=>s.permission.role==='seed');
      send(socket,{action:'announce',info_hash:m.info_hash,interval:60,complete:seeds.length,incomplete:group.size-seeds.length});
      if(m.answer) {
        const target=group.get(m.to_peer_id);
        if(target && p.role==='seed' && target.permission.role==='receiver') send(target,{action:'announce',info_hash:m.info_hash,peer_id:peerId,answer:m.answer,offer_id:m.offer_id});
      }
      if(p.role==='receiver' && Array.isArray(m.offers)) {
        const seed=seeds[0]?.[1]; if(seed) for(const offer of m.offers.slice(0,1)) send(seed,{action:'announce',info_hash:m.info_hash,peer_id:peerId,offer:offer.offer,offer_id:offer.offer_id});
      }
    } catch {socket.close(1008,'Unauthorized announce');}
  });
  socket.on('error',()=>{});
  socket.on('close',()=>{clearTimeout(deadline);if(peerId && group.get(peerId)===socket)group.delete(peerId);if(group.size===0)groups.delete(p.infoHash);});
  socket.resetRate=()=>{rate=0;};
});
const rateTimer=setInterval(()=>{attempts.clear();for(const s of ws.clients)s.resetRate?.();},60000);
const expiryTimer=setInterval(async()=>{try{await refreshSettings(db,c);}catch{for(const s of ws.clients)s.close(1011,'Unavailable');return;}for(const s of ws.clients){try{if(!await active(s.permission.albumId,s.permission.role==='seed'))s.close(1008,'Revoked');}catch{s.close(1011,'Unavailable');}}},1000);
http.listen(c.trackerPort,'127.0.0.1',()=>console.log('Private tracker listening'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{clearInterval(rateTimer);clearInterval(expiryTimer);for(const s of ws.clients)s.terminate();http.close(async()=>{await db.close();process.exit(0);});});
