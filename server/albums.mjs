import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat,statfs} from 'node:fs/promises';
import path from 'node:path';
import {one,audit} from './db.mjs';
import {token,hash,sign,fail,rangeHeader} from './security.mjs';

export async function owned(db,id,user) {
  const album=await one(db,'SELECT * FROM albums WHERE id=$1',[id]);
  if(!album || (album.owner_id!==user.id && user.role!=='admin')) fail(404,'セットが見つかりません'); return album;
}
export async function shared(db,value) {
  const album=await one(db,"SELECT a.*,s.id AS share_id FROM share_links s JOIN albums a ON a.id=s.album_id JOIN users u ON u.id=a.owner_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.expires_at>now() AND a.status='published' AND u.status='active'",[hash(value||'')]);
  if(!album) fail(404,'共有が見つからないか、公開が終了しました'); return album;
}
export async function seeder(c,endpoint,body) {
  const result=await fetch(`${c.seederURL}${endpoint}`,{method:'POST',headers:{'content-type':'application/json','x-internal-secret':c.internalSecret},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(!result.ok) fail(503,'シードサービスを利用できません'); return result.json();
}
export async function albumRoutes(app,db,c,route) {
  route('GET','/api/albums',null,[],async req=>{
    const albums=(await db.query(req.user.role==='admin'? 'SELECT * FROM albums ORDER BY created_at DESC LIMIT 200':'SELECT * FROM albums WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200',req.user.role==='admin'?[]:[req.user.id])).rows;
    return {albums};
  });
  route('POST','/api/albums',{title:{type:'string',minLength:1,maxLength:120},days:{type:'integer',minimum:1,maximum:90},consent:{type:'boolean',const:true}},['title','consent'],async req=>{
    if((req.body.days||c.retention)>c.retention)fail(400,'保持期間の上限を超えています');
    const id=randomUUID();
    await db.query('INSERT INTO albums(id,owner_id,title,expires_at) VALUES($1,$2,$3,$4)',[id,req.user.id,req.body.title,new Date(Date.now()+(req.body.days||c.retention)*86400000)]);
    await audit(db,req.user.id,'album.create','album',id); return {id};
  });
  route('GET','/api/albums/:id',null,[],async req=>{
    const album=await owned(db,req.params.id,req.user);
    const files=(await db.query('SELECT id,original_name,size_bytes,sha256,state FROM files WHERE album_id=$1 ORDER BY original_name',[album.id])).rows;
    const jobs=(await db.query('SELECT file_id,state,received_bytes,expected_bytes,error FROM upload_jobs WHERE album_id=$1',[album.id])).rows;
    return {album,files,jobs};
  });
  route('POST','/api/albums/:id/upload-authorizations',{
    name:{type:'string',minLength:1,maxLength:240,pattern:'^[^/\\\\\u0000-\u001f]+$'},size:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}
  },['name','size','sha256'],async req=>{
    if(req.body.size>c.maxAlbum)fail(413,'ファイル容量の上限を超えています');
    if(!/\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|dng|cr[23]|nef|arw|raf|orf|rw2|raw|zip|7z)$/i.test(req.body.name)) fail(400,'許可されていない拡張子です');
    const id=randomUUID(),job=randomUUID(),value=token(),expires=new Date(Date.now()+86400000);
    await db.transaction(async tx=>{
      // Global transaction lock serializes capacity reservation and upload concurrency.
      await tx.query('SELECT pg_advisory_xact_lock(887701)');
      const album=await owned(tx,req.params.id,req.user);
      if(!['draft','uploading'].includes(album.status) || new Date(album.expires_at)<=new Date()) fail(409,'このセットには追加できません');
      const totals=await one(tx,"SELECT COALESCE(sum(size_bytes),0) AS bytes FROM files f JOIN albums a ON a.id=f.album_id WHERE a.status<>'deleted'");
      if(Number(album.total_bytes)+req.body.size>c.maxAlbum || Number(totals.bytes)+req.body.size>c.budget) fail(413,'保存容量の上限を超えています');
      const active=await one(tx,"SELECT count(*) AS n FROM upload_jobs WHERE state IN ('authorized','uploading','processing') AND expires_at>now()");
      if(Number(active.n)>=c.maxUploads) fail(429,'同時アップロード上限です。完了後に再試行してください');
      const reserved=await one(tx,"SELECT COALESCE(sum(expected_bytes-received_bytes),0) AS bytes FROM upload_jobs WHERE state IN ('authorized','uploading','processing') AND expires_at>now()");
      const disk=await statfs(c.root); if(disk.bavail*disk.bsize < req.body.size+Number(reserved.bytes)+1024**3) fail(507,'ディスクの空き容量が不足しています');
      await tx.query('INSERT INTO files(id,album_id,original_name,stored_name,size_bytes,expected_sha256,mime_type) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,album.id,req.body.name,id,req.body.size,req.body.sha256,'application/octet-stream']);
      await tx.query('INSERT INTO upload_jobs(id,album_id,file_id,token_hash,expected_bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[job,album.id,id,hash(value),req.body.size,expires]);
      await tx.query("UPDATE albums SET total_bytes=total_bytes+$1,status='uploading' WHERE id=$2",[req.body.size,album.id]);
      await audit(tx,req.user.id,'upload.authorize','file',id);
    });
    return {fileId:id,jobId:job,token:value,expiresAt:expires,endpoint:'/uploads/'};
  });
  route('POST','/api/albums/:id/process',{},[],async req=>{
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM albums WHERE id=$1 FOR UPDATE',[req.params.id]);
      const album=await owned(tx,req.params.id,req.user);
      if(!['uploading','processing'].includes(album.status)) fail(409,'処理を開始できません');
      const pending=await one(tx,"SELECT count(*) AS n FROM files WHERE album_id=$1 AND state<>'complete'",[album.id]);
      const count=await one(tx,'SELECT count(*) AS n FROM files WHERE album_id=$1',[album.id]);
      if(Number(pending.n)>0 || Number(count.n)===0) fail(409,'全ファイルの検証完了を待ってください');
      await tx.query("UPDATE albums SET status='processing' WHERE id=$1",[album.id]);
      await tx.query('INSERT INTO torrent_swarms(id,album_id) VALUES($1,$2) ON CONFLICT(album_id) DO NOTHING',[randomUUID(),album.id]);
    });
    return {ok:true,p2p:c.p2p};
  });
  route('POST','/api/albums/:id/publish',{},[],async req=>{
    const value=token();
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM albums WHERE id=$1 FOR UPDATE',[req.params.id]);
      const album=await owned(tx,req.params.id,req.user);
      if(album.status!=='processing' || new Date(album.expires_at)<=new Date()) fail(409,'公開準備が完了していません');
      const pending=await one(tx,"SELECT count(*) AS n FROM files WHERE album_id=$1 AND state<>'complete'",[album.id]);
      const swarm=await one(tx,'SELECT * FROM torrent_swarms WHERE album_id=$1',[album.id]);
      if(Number(pending.n)>0 || (c.p2p && (swarm?.seed_status!=='ready' || new Date(swarm.last_announced_at).getTime()<Date.now()-30000))) fail(409,'検証またはシード準備が完了していません');
      await tx.query('INSERT INTO share_links(id,album_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',[randomUUID(),album.id,hash(value),album.expires_at]);
      await tx.query("UPDATE albums SET status='published' WHERE id=$1",[album.id]);
      await audit(tx,req.user.id,'album.publish','album',album.id);
    }); return {url:`${c.origin}/s/${value}`};
  });
  route('POST','/api/albums/:id/revoke',{},[],async req=>{
    const album=await owned(db,req.params.id,req.user); if(['deleted','expired'].includes(album.status)) fail(409,'公開は終了しています');
    await db.transaction(async tx=>{
      await tx.query("UPDATE albums SET status='revoked' WHERE id=$1",[album.id]);
      await tx.query('UPDATE share_links SET revoked_at=now() WHERE album_id=$1',[album.id]);
      await tx.query('DELETE FROM peer_sessions WHERE album_id=$1',[album.id]);
      await audit(tx,req.user.id,'album.revoke','album',album.id);
    });
    // Database revocation is immediate; seeder also polls and closes all wires.
    if(c.p2p) await seeder(c,'/stop',{albumId:album.id}); return {ok:true};
  });
  route('POST','/api/albums/:id/delete',{},[],async req=>{
    const album=await owned(db,req.params.id,req.user);
    await db.transaction(async tx=>{
      await tx.query("UPDATE albums SET status='revoked',expires_at=now() WHERE id=$1 AND status<>'deleted'",[album.id]);
      await tx.query('UPDATE share_links SET revoked_at=now() WHERE album_id=$1',[album.id]);
      await tx.query('DELETE FROM peer_sessions WHERE album_id=$1',[album.id]);
      await audit(tx,req.user.id,'album.delete-request','album',album.id);
    }); if(c.p2p) await seeder(c,'/stop',{albumId:album.id}); return {ok:true};
  });
  route('GET','/api/s/:shareToken',null,[],async req=>{
    const album=await shared(db,req.params.shareToken);
    const files=(await db.query("SELECT id,original_name,size_bytes,sha256,preview FROM files WHERE album_id=$1 AND state='complete' ORDER BY original_name",[album.id])).rows;
    return {title:album.title,totalBytes:album.total_bytes,expiresAt:album.expires_at,files,p2p:c.p2p,contact:c.contact};
  },{auth:false});
  route('POST','/api/s/:shareToken/peer-session',{},[],async req=>{
    if(!c.p2p) fail(503,'P2Pは受入試験完了まで無効です。HTTP取得をご利用ください');
    const album=await shared(db,req.params.shareToken),id=token();
    const swarm=await one(db,"SELECT * FROM torrent_swarms WHERE album_id=$1 AND seed_status='ready' AND last_announced_at>now()-interval '30 seconds'",[album.id]);
    if(!swarm) fail(503,'シード準備中です');
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM albums WHERE id=$1 FOR UPDATE',[album.id]);
      const count=await one(tx,'SELECT count(*) AS n FROM peer_sessions WHERE expires_at>now()');
      if(Number(count.n)>=c.maxPeers) fail(429,'接続上限です。HTTP取得をご利用ください');
      await tx.query('INSERT INTO peer_sessions(id,album_id,expires_at) VALUES($1,$2,$3)',[hash(id),album.id,new Date(Date.now()+300000)]);
    });
    const permission=sign({purpose:'peer',albumId:album.id,infoHash:swarm.info_hash,session:hash(id),role:'receiver'},c.tokenSecret,300);
    return {infoHash:swarm.info_hash,announce:`${c.trackerURL}?ticket=${permission}`,iceServers:c.stun.map(url=>({urls:url})),turnEnabled:false,expiresIn:300};
  },{auth:false,limit:20});
  route('GET','/api/s/:shareToken/files/:fileId',null,[],async(req,reply)=>{
    const album=await shared(db,req.params.shareToken);
    const file=await one(db,"SELECT * FROM files WHERE id=$1 AND album_id=$2 AND state='complete'",[req.params.fileId,album.id]);
    if(!file) fail(404,'ファイルが見つかりません');
    const filename=path.join(c.root,'files',album.id,file.stored_name),info=await stat(filename);
    if(info.size!==Number(file.size_bytes)) fail(503,'保存ファイルの整合性エラー');
    const etag=`"${file.sha256}"`;
    const r=rangeHeader(req.headers['if-range'] && req.headers['if-range']!==etag?null:req.headers.range,info.size);
    reply.header('Accept-Ranges','bytes').header('ETag',etag).header('Cache-Control','private, no-store');
    if(!r) return reply.code(416).header('Content-Range',`bytes */${info.size}`).send();
    reply.header('Content-Disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.original_name).replace(/'/g,'%27')}`)
      .header('Content-Length',r.end-r.start+1).type('application/octet-stream').code(r.status);
    if(r.status===206) reply.header('Content-Range',`bytes ${r.start}-${r.end}/${info.size}`);
    if(req.method==='HEAD') return reply.send();
    const stream=createReadStream(filename,{start:r.start,end:r.end,highWaterMark:256*1024});
    const abort=()=>stream.destroy(); req.raw.on('aborted',abort); reply.raw.on('close',abort);
    // Fail closed when a share expires or is revoked during an active response.
    const timer=setInterval(()=>shared(db,req.params.shareToken).catch(abort),1000); timer.unref();
    stream.on('close',()=>{clearInterval(timer); req.raw.off('aborted',abort); reply.raw.off('close',abort);
      db.query('INSERT INTO download_events(album_id,pathway,bytes_sent) VALUES($1,$2,$3)',[album.id,'http',stream.bytesRead]).catch(()=>{});
    });
    return reply.send(stream);
  },{auth:false,limit:120});
}
