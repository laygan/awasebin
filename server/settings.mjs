import {one,audit} from './db.mjs';
import {fail} from './security.mjs';
export const settingSchema={
 maxAlbum:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},budget:{type:'integer',minimum:1024**3,maximum:Number.MAX_SAFE_INTEGER},
 maxUploads:{type:'integer',minimum:1,maximum:20},maxPeers:{type:'integer',minimum:1,maximum:100},
 retention:{type:'integer',minimum:1,maximum:90},sessionSeconds:{type:'integer',minimum:300,maximum:86400},p2p:{type:'boolean'}
};
export function settingsView(c){return Object.fromEntries(Object.keys(settingSchema).map(key=>[key,c[key]]));}
export async function refreshSettings(db,c){
 const s=await one(db,'SELECT configuration FROM system_settings WHERE id=1');
 if(s)for(const key of Object.keys(settingSchema))if(s.configuration[key]!==undefined)c[key]=s.configuration[key];
 c.p2p=c.p2pAllowed && c.p2p;
}
export function settingsRoutes(db,c,route){
 route('GET','/api/admin/settings',null,[],async()=>({settings:settingsView(c),p2pAllowed:c.p2pAllowed}),{admin:true});
 route('POST','/api/admin/settings',settingSchema,Object.keys(settingSchema),async req=>{
   if(req.body.p2p && !c.p2pAllowed)fail(409,'P2PはVM側で受入後に許可する必要があります');
   if(req.body.maxAlbum>req.body.budget)fail(400,'セット上限は総容量以下にしてください');
   await db.transaction(async tx=>{
     await tx.query('INSERT INTO system_settings(id,configuration) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET configuration=EXCLUDED.configuration,updated_at=now()',[JSON.stringify(req.body)]);
     await audit(tx,req.user.id,'settings.update','system','1');
   });await refreshSettings(db,c);return {settings:settingsView(c)};
 },{admin:true});
 route('GET','/api/admin/metrics',null,[],async()=>({
   transfers:(await db.query("SELECT pathway,count(*) AS transfers,COALESCE(sum(bytes_sent),0) AS bytes FROM download_events WHERE created_at>now()-interval '1 day' GROUP BY pathway")).rows,
   uploads:(await db.query('SELECT state,count(*) AS jobs FROM upload_jobs GROUP BY state')).rows,
   seeds:(await db.query('SELECT seed_status,count(*) AS swarms FROM torrent_swarms GROUP BY seed_status')).rows
 }),{admin:true});
}
