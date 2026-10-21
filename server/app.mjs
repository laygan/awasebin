import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import {mkdir,statfs} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {one} from './db.mjs';
import {hash,bots,fail,equal} from './security.mjs';
import {authRoutes} from './auth.mjs';
import {albumRoutes,shared} from './albums.mjs';
import {uploadRoutes} from './uploads.mjs';
import {refreshSettings,settingsRoutes} from './settings.mjs';
import {successSchema} from './openapi.mjs';

export async function createApp(db,c) {
  for(const d of ['uploads','files','previews','torrents']) await mkdir(path.join(c.root,d),{recursive:true});
  // Deliberately omit request URLs, headers, bodies and credentials from application logs.
  const app=Fastify({logger:false,bodyLimit:128*1024,trustProxy:false,disableRequestLogging:true});
  await app.register(cookie);
  await refreshSettings(db,c);
  let refreshed=Date.now();
  await app.register(rateLimit,{max:120,timeWindow:60000,allowList:[],keyGenerator:req=>req.ip});
  await app.register(swagger,{openapi:{info:{title:'あわせ便 API',version:'0.1.0'},servers:[{url:c.origin}],components:{securitySchemes:{session:{type:'apiKey',in:'cookie',name:'session'},csrf:{type:'apiKey',in:'header',name:'x-csrf-token'}}}}});
  app.addHook('onRequest',async(req,reply)=>{
    if(Date.now()-refreshed>5000){await refreshSettings(db,c);refreshed=Date.now();}
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('X-Robots-Tag','noindex, nofollow, noarchive, noimageindex').header('Cache-Control','no-store').header('Cross-Origin-Resource-Policy','same-origin');
    if(bots.test(req.headers['user-agent']||'')) fail(403,'自動収集・AIアクセスは禁止されています');
    if(!['GET','HEAD','OPTIONS'].includes(req.method) && !req.url.startsWith('/api/internal/')) {
      if(req.headers.origin!==c.origin) fail(403,'送信元を確認できません');
      if(req.cookies.session) {
        const s=await one(db,'SELECT csrf_hash FROM sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()',[hash(req.cookies.session)]);
        const ceremony=/^\/api\/auth\/(login|register)\/(options|verify)$/.test(req.url);
        if(s && !equal(s.csrf_hash,hash(req.headers['x-csrf-token']||''))) fail(403,'セッションを再確認してください');
        if(!s && !ceremony) fail(403,'セッションを再確認してください');
        if(!s && ceremony) reply.clearCookie('session',{path:'/'}).clearCookie('csrf',{path:'/'});
      }
    }
  });
  app.setErrorHandler((error,req,reply)=>{
    const status=error.validation?400:(error.statusCode>=400 && error.statusCode<600?error.statusCode:500);
    reply.code(status).send({error:status>=500?'処理に失敗しました。しばらくして再試行してください':error.validation?'入力内容が正しくありません':error.message});
  });
  app.setNotFoundHandler((req,reply)=>reply.code(404).send({error:'見つかりません'}));
  function route(method,url,properties,required,handler,opts={}) {
    const params={}; for(const match of url.matchAll(/:([A-Za-z]+)/g)) params[match[1]]=match[1]==='id'||match[1]==='fileId'?{type:'string',format:'uuid'}:{type:'string',minLength:40,maxLength:100};
    app.route({method,url,config:{rateLimit:{max:opts.limit||120,timeWindow:60000}},schema:{
      tags:[url.split('/')[2]||'system'],security:opts.auth===false?[]:[{session:[],csrf:[]}],
      ...(properties?{body:{type:'object',additionalProperties:false,properties,required}}:{}),
      ...(Object.keys(params).length?{params:{type:'object',properties:params,required:Object.keys(params)}}:{}),
      response:{200:successSchema(method,url),...(url.endsWith('/files/:fileId')?{206:{type:'string',format:'binary'}}:{}),'4xx':{type:'object',properties:{error:{type:'string'}}},'5xx':{type:'object',properties:{error:{type:'string'}}}},
      description:`${opts.internal?'Internal service secret required. ':''}Rate limit: ${opts.limit||120} requests/minute per IP. Errors: {error: string}.`
    },preHandler:async req=>{
      if(opts.auth===false) return;
      const user=await one(db,"SELECT u.id,u.display_name,u.role,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND u.status='active'",[hash(req.cookies.session||'')]);
      if(!user) fail(401,'パスキーでログインしてください'); if(opts.admin && user.role!=='admin') fail(403,'管理者権限が必要です'); req.user=user;
    },handler});
  }
  await authRoutes(app,db,c,route); await albumRoutes(app,db,c,route); await uploadRoutes(app,db,c,route);settingsRoutes(db,c,route);
  route('GET','/api/s/:shareToken/previews/:fileId',null,[],async(req,reply)=>{
    const album=await shared(db,req.params.shareToken);
    const file=await one(db,"SELECT id FROM files WHERE id=$1 AND album_id=$2 AND preview=true AND state='complete'",[req.params.fileId,album.id]);
    if(!file) fail(404,'プレビューはありません');
    return reply.type('image/webp').send(createReadStream(path.join(c.root,'previews',album.id,`${file.id}.webp`)));
  },{auth:false});
  route('GET','/api/admin/openapi',null,[],async()=>app.swagger(),{admin:true});
  route('GET','/api/public/config',null,[],async()=>({contact:c.contact,p2p:c.p2p,retention:c.retention}),{auth:false});
  app.get('/robots.txt',async(req,reply)=>reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/health/live',async()=>({status:'ok'}));
  app.get('/health/ready',async(req,reply)=>{
    try {
      await db.query('SELECT 1'); const disk=await statfs(c.root); if(disk.bavail*disk.bsize<1024**3) throw new Error('disk');
      if(c.p2p) { const r=await fetch(`${c.seederURL}/health`,{headers:{'x-internal-secret':c.internalSecret},signal:AbortSignal.timeout(3000)}); if(!r.ok) throw new Error('seeder'); }
      return {status:'ready'};
    } catch { return reply.code(503).send({status:'unavailable'}); }
  });
  return app;
}
