import WebTorrent from 'webtorrent';
import createTorrent from 'create-torrent';
import parseTorrent from 'parse-torrent';
import Fastify from 'fastify';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {config} from './config.mjs';
import {database,one} from './db.mjs';
import {sign,equal} from './security.mjs';
import {refreshSettings} from './settings.mjs';
const c=config(),db=database(c.databaseURL),torrents=new Map();
if(c.p2p && !WebTorrent.WEBRTC_SUPPORT) throw new Error('Node WebRTC support missing: install supported native dependencies and complete PoC');
const client=new WebTorrent({dht:false,lsd:false,utPex:false,natUpnp:false,natPmp:false,webSeeds:false,utp:false,maxConns:c.maxPeers,tracker:{rtcConfig:{iceServers:c.stun.map(url=>({urls:url}))}}});
client.on('error',()=>console.error('Seeder transport error'));
async function stop(id) {
  const t=torrents.get(id);if(t){torrents.delete(id);for(const w of t.wires)w.destroy();await new Promise(resolve=>client.remove(t.infoHash,{destroyStore:true},()=>resolve()));}
  await db.query("UPDATE torrent_swarms SET seed_status='stopped' WHERE album_id=$1",[id]);
}
async function sync() {
  if(!c.p2p)return;
  const albums=(await db.query("SELECT a.* FROM albums a JOIN torrent_swarms s ON s.album_id=a.id JOIN users u ON u.id=a.owner_id WHERE a.status IN ('processing','published') AND a.expires_at>now() AND u.status='active'")).rows;
  for(const id of torrents.keys())if(!albums.some(a=>a.id===id))await stop(id);
  for(const album of albums) {
    if(torrents.has(album.id)) {await db.query('UPDATE torrent_swarms SET last_announced_at=now() WHERE album_id=$1',[album.id]);continue;}
    const directory=path.join(c.root,'files',album.id);
    // Build metadata before joining, so the tracker credential can bind to its info hash.
    let manifest;
    try {manifest=await readFile(path.join(c.root,'torrents',`${album.id}.torrent`));}
    catch(e){if(e.code!=='ENOENT')throw e;manifest=await new Promise((resolve,reject)=>createTorrent(directory,{name:album.id,private:true,announceList:[],pieceLength:4*1024*1024},(err,data)=>err?reject(err):resolve(data)));}
    const parsed=await parseTorrent(manifest);
    if(parsed.announce.length || !parsed.private)throw new Error('Unsafe torrent metadata');
    const ticket=sign({purpose:'peer',albumId:album.id,infoHash:parsed.infoHash,role:'seed'},c.tokenSecret,Math.max(1,Math.floor((new Date(album.expires_at)-Date.now())/1000)));
    const torrent=client.add(manifest,{path:path.join(c.root,'files'),announce:[`${c.trackerURL}?ticket=${ticket}`],skipVerify:false});
    torrents.set(album.id,torrent);
    torrent.on('error',()=>{db.query("UPDATE torrent_swarms SET seed_status='error' WHERE album_id=$1",[album.id]).catch(()=>{});});
    torrent.on('wire',async(wire,addr)=>{
      wire.choke();
      let authorized=false;
      const unchoke=wire.unchoke.bind(wire);
      wire.unchoke=()=>{if(authorized)unchoke();};
      try {
        if(wire.type!=='webrtc')return wire.destroy();
        if([...torrents.values()].reduce((n,t)=>n+t.wires.length,0)>c.maxPeers)return wire.destroy();
        const peerId=wire.peerId || wire._peerId;
        const hex=typeof peerId==='string'?peerId:peerId?Buffer.from(peerId).toString('hex'):'';
        const allowed=await one(db,"SELECT p.id FROM peer_sessions p JOIN albums a ON a.id=p.album_id JOIN users u ON u.id=a.owner_id WHERE p.album_id=$1 AND p.peer_id=$2 AND p.expires_at>now() AND a.status='published' AND a.expires_at>now() AND u.status='active'",[album.id,hex]);
        if(!allowed)return wire.destroy(); authorized=true;wire.unchoke();
        let sent=0;wire.on('upload',bytes=>{sent+=bytes;});
        wire.once('close',()=>db.query('INSERT INTO download_events(album_id,pathway,bytes_sent) VALUES($1,$2,$3)',[album.id,'p2p',sent]).catch(()=>{}));
      } catch {wire.destroy();}
    });
    await mkdir(path.join(c.root,'torrents'),{recursive:true});
    await writeFile(path.join(c.root,'torrents',`${album.id}.torrent`),manifest);
    await new Promise((resolve,reject)=>{if(torrent.done)return resolve();torrent.once('done',resolve);torrent.once('error',reject);torrent.once('close',()=>reject(new Error('Stopped')));});
    const active=await one(db,"SELECT id FROM albums WHERE id=$1 AND status IN ('processing','published') AND expires_at>now()",[album.id]);
    if(!active){await stop(album.id);continue;}
    await db.query("UPDATE torrent_swarms SET info_hash=$1,torrent_manifest_path=$2,seed_status='ready',last_announced_at=now() WHERE album_id=$3",[torrent.infoHash,`${album.id}.torrent`,album.id]);
  }
}
let syncing=false;
const timer=setInterval(async()=>{if(syncing)return;syncing=true;try{await sync();}catch{console.error('Seeder reconciliation failed');}finally{syncing=false;}},1000);
let checking=false;
const safetyTimer=setInterval(async()=>{
  if(checking)return;checking=true;
  try{await refreshSettings(db,c);client.maxConns=c.maxPeers;for(const [id,t] of torrents){
    const allowed=await one(db,"SELECT a.id FROM albums a JOIN users u ON u.id=a.owner_id WHERE a.id=$1 AND a.status IN ('processing','published') AND a.expires_at>now() AND u.status='active'",[id]);
    if(!allowed || !c.p2p)await stop(id);else if(t.done)await db.query('UPDATE torrent_swarms SET last_announced_at=now() WHERE album_id=$1',[id]);
  }}catch{for(const t of torrents.values())for(const w of t.wires)w.destroy();}finally{checking=false;}
},1000);
const api=Fastify({logger:false});
api.addHook('onRequest',async(req,reply)=>{if(!equal(req.headers['x-internal-secret'],c.internalSecret))return reply.code(401).send({error:'Unauthorized'});});
api.get('/health',async()=>({status:'ready',p2p:c.p2p,swarms:torrents.size}));
api.post('/stop',async req=>{await stop(req.body.albumId);return {ok:true};});
await api.listen({host:'127.0.0.1',port:c.seederPort});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{clearInterval(timer);clearInterval(safetyTimer);await api.close();await new Promise(r=>client.destroy(r));await db.close();process.exit(0);});
