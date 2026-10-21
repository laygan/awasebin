import {rm,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {one,audit} from './db.mjs';
import {seeder} from './albums.mjs';
export async function cleanup(db,c) {
  const albums=(await db.query("SELECT * FROM albums WHERE status<>'deleted' AND (expires_at<=now() OR status IN ('revoked','expired'))")).rows;
  for(const album of albums) {
    await db.transaction(async tx=>{
      await tx.query("UPDATE albums SET status='expired' WHERE id=$1",[album.id]);
      await tx.query('UPDATE share_links SET revoked_at=now() WHERE album_id=$1',[album.id]);
      await tx.query('DELETE FROM peer_sessions WHERE album_id=$1',[album.id]);
    });
    if(c.p2p) await seeder(c,'/stop',{albumId:album.id});
    for(const dir of ['files','previews'])await safeRemove(c.root,path.join(c.root,dir,album.id));
    await safeRemove(c.root,path.join(c.root,'torrents',`${album.id}.torrent`));
    const jobs=(await db.query('SELECT tus_upload_id FROM upload_jobs WHERE album_id=$1',[album.id])).rows;
    for(const j of jobs) if(j.tus_upload_id) for(const suffix of ['', '.info'])await safeRemove(c.root,path.join(c.root,'uploads',`${j.tus_upload_id}${suffix}`));
    await db.transaction(async tx=>{
      await tx.query("UPDATE albums SET status='deleted',total_bytes=0 WHERE id=$1",[album.id]);
      await tx.query('UPDATE files SET preview=false WHERE album_id=$1',[album.id]);
      await tx.query("UPDATE upload_jobs SET state='failed',token_hash='',error='保持期限終了' WHERE album_id=$1 AND state<>'complete'",[album.id]);
      await audit(tx,null,'album.cleanup','album',album.id);
    });
  }
  const expired=(await db.query("SELECT * FROM upload_jobs WHERE expires_at<now() AND state IN ('authorized','uploading','processing','failed')")).rows;
  for(const j of expired) {
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM albums WHERE id=$1 FOR UPDATE',[j.album_id]);
      const current=await one(tx,'SELECT state FROM upload_jobs WHERE id=$1',[j.id]);
      if(current?.state==='complete')return;
      if(j.tus_upload_id)for(const suffix of ['', '.info'])await safeRemove(c.root,path.join(c.root,'uploads',`${j.tus_upload_id}${suffix}`));
      await tx.query("UPDATE upload_jobs SET state='failed',token_hash='',error='アップロード権限の期限切れ' WHERE id=$1",[j.id]);
    });
  }
  // Orphaned tus files (e.g. pre-create succeeded before a client disappeared).
  for(const name of await readdir(path.join(c.root,'uploads'))) {
    if(!/^[a-f0-9-]{36}(\.info)?$/.test(name))continue;
    const f=path.join(c.root,'uploads',name),s=await stat(f);
    if(s.mtimeMs<Date.now()-2*86400000 && !await one(db,"SELECT id FROM upload_jobs WHERE tus_upload_id=$1 AND state IN ('uploading','processing') AND expires_at>now()",[name.replace(/\.info$/,'')]))await safeRemove(c.root,f);
  }
  await db.query('DELETE FROM challenges WHERE expires_at<now()');
  await db.query("DELETE FROM sessions WHERE expires_at<now()-interval '1 day' OR revoked_at<now()-interval '1 day'");
  await db.query('DELETE FROM peer_sessions WHERE expires_at<now()');
  await db.query("DELETE FROM download_events WHERE created_at<now()-interval '14 days'");
  await db.query("DELETE FROM audit_logs WHERE timestamp<now()-interval '90 days'");
}
export async function safeRemove(root,target) {
  const resolved=path.resolve(target),base=path.resolve(root)+path.sep;
  if(!resolved.startsWith(base) || resolved===path.resolve(root)) throw new Error('Refusing deletion outside storage root');
  await rm(resolved,{recursive:true,force:true});
}
