import path from 'node:path';
import {createReadStream} from 'node:fs';
import {mkdir,stat,rename,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {one,audit} from './db.mjs';
import {equal,hash,fail} from './security.mjs';

export async function uploadRoutes(app,db,c,route) {
  route('POST','/api/internal/tus-hook',{
    Type:{type:'string',enum:['pre-create','post-receive','post-finish','pre-terminate','post-terminate']},
    Event:{type:'object',additionalProperties:true}
  },['Type','Event'],async(req,reply)=>{
    if(!equal(req.headers['x-internal-secret'],c.internalSecret)) fail(401,'Unauthorized');
    const {Type,Event}=req.body,u=Event.Upload;
    if(!u || u.IsPartial || u.IsFinal) return {RejectUpload:true,HTTPResponse:{StatusCode:403,Body:'Concatenation is disabled'}};
    if(Type==='pre-create') {
      const headers=Event.HTTPRequest?.Header||{};
      const value=headers['Upload-Token']?.[0]||headers['upload-token']?.[0]||'';
      try {
        const job=await db.transaction(async tx=>{
          const j=await one(tx,"SELECT j.*,a.status AS album_status,a.expires_at AS album_expiry,u.status AS user_status FROM upload_jobs j JOIN albums a ON a.id=j.album_id JOIN users u ON u.id=a.owner_id WHERE j.token_hash=$1 FOR UPDATE OF j",[hash(value)]);
          if(!j || j.state!=='authorized' || j.user_status!=='active' || j.album_status!=='uploading' || new Date(j.expires_at)<=new Date() || new Date(j.album_expiry)<=new Date() || Number(j.expected_bytes)!==u.Size || u.SizeIsDeferred) fail(403,'Upload denied');
          await tx.query("UPDATE upload_jobs SET tus_upload_id=id::text,state='uploading',updated_at=now() WHERE id=$1",[j.id]); return j;
        });
        return {ChangeFileInfo:{ID:job.id,MetaData:{job:job.id}}};
      } catch { return {RejectUpload:true,HTTPResponse:{StatusCode:403,Body:'Upload denied'}}; }
    }
    const id=u.ID;
    if(!/^[0-9a-f-]{36}$/.test(id)) fail(400,'Invalid upload ID');
    const job=await one(db,'SELECT * FROM upload_jobs WHERE tus_upload_id=$1',[id]); if(!job) fail(404,'Unknown upload');
    if(Type==='post-receive') await db.query("UPDATE upload_jobs SET received_bytes=GREATEST(received_bytes,$1),updated_at=now() WHERE id=$2 AND state='uploading'",[Math.min(Number(u.Offset),Number(job.expected_bytes)),job.id]);
    if(Type==='post-finish') {
      // No filesystem processing in HTTP hook; durable state is consumed by a single worker.
      await db.query("UPDATE upload_jobs SET state='processing',received_bytes=expected_bytes,updated_at=now() WHERE id=$1 AND state='uploading'",[job.id]);
    }
    if(Type==='pre-terminate') return {RejectTermination:true,HTTPResponse:{StatusCode:403,Body:'Delete the album instead'}};
    return {};
  },{auth:false,internal:true,limit:100000});
  route('GET','/api/internal/tus-authorize',null,[],async(req,reply)=>{
    if(!equal(req.headers['x-internal-secret'],c.internalSecret)) fail(401,'Unauthorized');
    const uri=(req.headers['x-original-uri']||'').split('?')[0],method=req.headers['x-original-method'];
    if(method==='OPTIONS') return reply.code(204).send();
    const match=/^\/uploads\/(?:([a-f0-9-]{36}))?$/.exec(uri);
    if(!match || !['POST','HEAD','PATCH'].includes(method)) fail(403,'Upload denied');
    if((method==='POST' && match[1]) || (method!=='POST' && !match[1])) fail(403,'Upload denied');
    const job=await one(db,"SELECT j.*,a.expires_at AS album_expiry,a.status AS album_status,u.status AS user_status FROM upload_jobs j JOIN albums a ON a.id=j.album_id JOIN users u ON u.id=a.owner_id WHERE j.token_hash=$1",[hash(req.headers['upload-token']||'')]);
    if(!job || job.user_status!=='active' || !['authorized','uploading'].includes(job.state) || new Date(job.expires_at)<=new Date() || new Date(job.album_expiry)<=new Date() || job.album_status!=='uploading' || (match[1] && match[1]!==job.tus_upload_id)) fail(403,'Upload denied');
    return reply.code(204).send();
  },{auth:false,internal:true,limit:100000});
}

export async function processUploads(db,c) {
  // Reconcile completion after hook delivery failure or a service restart.
  const interrupted=(await db.query("SELECT tus_upload_id,expected_bytes FROM upload_jobs WHERE state='uploading' AND expires_at>now()")).rows;
  for(const job of interrupted) {
    try {
      const info=await stat(path.join(c.root,'uploads',job.tus_upload_id));
      if(info.size===Number(job.expected_bytes) && info.mtimeMs<Date.now()-5000) await db.query("UPDATE upload_jobs SET state='processing',received_bytes=expected_bytes,updated_at=now() WHERE tus_upload_id=$1 AND state='uploading'",[job.tus_upload_id]);
    } catch {/* A partial upload has no completed state yet. */}
  }
  const jobs=(await db.query("SELECT j.*,f.expected_sha256,f.stored_name FROM upload_jobs j JOIN files f ON f.id=j.file_id WHERE j.state='processing' ORDER BY j.updated_at LIMIT 2")).rows;
  for(const job of jobs) {
    // The album lock also serializes cleanup and prevents finalizing files after deletion.
    await db.transaction(async tx=>{
    const album=await one(tx,'SELECT status,expires_at FROM albums WHERE id=$1 FOR UPDATE',[job.album_id]);
    const current=await one(tx,'SELECT state FROM upload_jobs WHERE id=$1 FOR UPDATE',[job.id]);
    if(!album || !['uploading','processing'].includes(album.status) || new Date(album.expires_at)<=new Date() || current.state!=='processing') return;
    const destination=path.join(c.root,'files',job.album_id,job.stored_name);
    const source=path.join(c.root,'uploads',job.tus_upload_id);
    try {
      let file=source;
      try {await stat(source);} catch(e) {if(e.code!=='ENOENT') throw e; file=destination;}
      const info=await stat(file); if(info.size!==Number(job.expected_bytes)) throw new Error('size mismatch');
      const digest=createHash('sha256'); for await(const chunk of createReadStream(file)) digest.update(chunk);
      const sha=digest.digest('hex'); if(sha!==job.expected_sha256) throw new Error('sha256 mismatch');
      await mkdir(path.dirname(destination),{recursive:true});
      if(file!==destination) await rename(source,destination);
      const preview=await makePreview(c,job.album_id,job.file_id,destination);
        await tx.query("UPDATE files SET state='complete',sha256=$1,preview=$2 WHERE id=$3",[sha,preview,job.file_id]);
        await tx.query("UPDATE upload_jobs SET state='complete',updated_at=now() WHERE id=$1 AND state='processing'",[job.id]);
        await audit(tx,null,'upload.complete','file',job.file_id);
      await unlink(`${source}.info`).catch(()=>{});
    } catch(e) {
      const reason=e.message==='sha256 mismatch'?'SHA-256が一致しません':e.message==='size mismatch'?'サイズが一致しません':'ファイル検証に失敗しました';
      await tx.query("UPDATE upload_jobs SET state='failed',error=$1,updated_at=now() WHERE id=$2",[reason,job.id]);
      await tx.query("UPDATE files SET state='failed' WHERE id=$1",[job.file_id]);
      await audit(tx,null,'upload.verify','file',job.file_id,'failed');
    }
    });
  }
}
function makePreview(c,albumId,fileId,source) {
  return new Promise(resolve=>{
    const dest=path.join(c.root,'previews',albumId,`${fileId}.webp`);
    const child=spawn(process.execPath,['--max-old-space-size=128',new URL('./preview.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),source,dest],{stdio:'ignore',windowsHide:true,env:{...process.env,VIPS_CONCURRENCY:'1',MALLOC_ARENA_MAX:'2'}});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
    child.once('error',()=>{clearTimeout(timeout);resolve(false);});
    child.once('exit',code=>{clearTimeout(timeout);resolve(code===0);});
  });
}
