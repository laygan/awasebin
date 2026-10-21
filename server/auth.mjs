import { randomUUID } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { one, audit } from './db.mjs';
import { token, hash, fail } from './security.mjs';

export async function authRoutes(app,db,c,route) {
  const cookieOptions = {httpOnly:true,secure:c.production,sameSite:'strict',path:'/'};
  async function challenge(req,reply,purpose,data,invitationId=null,userId=null) {
    const id=token();
    await db.query('INSERT INTO challenges(id,challenge,purpose,invitation_id,user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[hash(id),data.challenge,purpose,invitationId,userId,new Date(Date.now()+300000)]);
    reply.setCookie('ceremony',id,{...cookieOptions,maxAge:300}); return data;
  }
  async function consume(req,reply,purpose) {
    const ch=await one(db,'DELETE FROM challenges WHERE id=$1 AND purpose=$2 AND expires_at>now() RETURNING *',[hash(req.cookies.ceremony||''),purpose]);
    reply.clearCookie('ceremony',cookieOptions); if(!ch) fail(401,'認証を最初からやり直してください'); return ch;
  }
  async function session(req,reply,userId) {
    const id=token(), csrf=token();
    await db.transaction(async tx=>{
      const user=await one(tx,"SELECT id FROM users WHERE id=$1 AND status='active' FOR UPDATE",[userId]);
      if(!user)fail(401,'アカウントが停止されています');
      if(req.cookies.session)await tx.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[hash(req.cookies.session)]);
      await tx.query('INSERT INTO sessions(id,user_id,csrf_hash,expires_at) VALUES($1,$2,$3,$4)',[hash(id),userId,hash(csrf),new Date(Date.now()+c.sessionSeconds*1000)]);
    });
    reply.setCookie('session',id,{...cookieOptions,maxAge:c.sessionSeconds});
    reply.setCookie('csrf',csrf,{...cookieOptions,httpOnly:false,maxAge:c.sessionSeconds});
  }
  const invitation = async value => {
    const inv=await one(db,'SELECT * FROM invitations WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND attempts<10',[hash(value||'')]);
    if(!inv) fail(403,'招待が無効、使用済み、または期限切れです'); return inv;
  };
  route('POST','/api/auth/register/options',{token:{type:'string',minLength:40,maxLength:100}},['token'],async(req,reply)=>{
    const inv=await invitation(req.body.token);
    await db.query('UPDATE invitations SET attempts=attempts+1 WHERE id=$1',[inv.id]);
    const id=inv.recovery_user_id || randomUUID();
    const options=await generateRegistrationOptions({rpName:'あわせ便',rpID:c.rpID,userName:inv.display_name,userID:Buffer.from(id),attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'}});
    return challenge(req,reply,'register',options,inv.id,id);
  },{auth:false,limit:10});
  route('POST','/api/auth/register/verify',{token:{type:'string',maxLength:100},response:{type:'object',additionalProperties:true}},['token','response'],async(req,reply)=>{
    const ch=await consume(req,reply,'register'), inv=await invitation(req.body.token);
    if(ch.invitation_id!==inv.id) fail(403,'招待が一致しません');
    const result=await verifyRegistrationResponse({response:req.body.response,expectedChallenge:ch.challenge,expectedOrigin:c.origin,expectedRPID:c.rpID,requireUserVerification:true});
    if(!result.verified) fail(401,'パスキーを検証できません');
    const {credential,credentialBackedUp,credentialDeviceType}=result.registrationInfo;
    await db.transaction(async tx=>{
      const used=await one(tx,'UPDATE invitations SET used_at=now() WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING id',[inv.id]);
      if(!used) fail(403,'招待は既に使用されています');
      if(inv.recovery_user_id) await tx.query("UPDATE users SET status='active' WHERE id=$1",[ch.user_id]);
      else await tx.query('INSERT INTO users(id,display_name,role) VALUES($1,$2,$3)',[ch.user_id,inv.display_name,inv.role]);
      await saveCredential(tx,ch.user_id,credential,credentialBackedUp,credentialDeviceType);
      await audit(tx,ch.user_id,'register','user',ch.user_id);
    });
    await session(req,reply,ch.user_id); return {ok:true};
  },{auth:false,limit:10});
  route('POST','/api/auth/login/options',{},[],async(req,reply)=>challenge(req,reply,'login',await generateAuthenticationOptions({rpID:c.rpID,userVerification:'required'})),{auth:false,limit:20});
  route('POST','/api/auth/login/verify',{response:{type:'object',additionalProperties:true}},['response'],async(req,reply)=>{
    const ch=await consume(req,reply,'login');
    const credential=await one(db,"SELECT p.* FROM passkey_credentials p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND p.revoked_at IS NULL AND u.status='active'",[req.body.response.id]);
    if(!credential) fail(401,'認証できません');
    const result=await verifyAuthenticationResponse({response:req.body.response,expectedChallenge:ch.challenge,expectedOrigin:c.origin,expectedRPID:c.rpID,requireUserVerification:true,
      credential:{id:credential.id,publicKey:new Uint8Array(credential.public_key),counter:Number(credential.counter),transports:credential.transports}});
    if(!result.verified) fail(401,'認証できません');
    const updated=await db.query('UPDATE passkey_credentials SET counter=$1,backup_state=$2 WHERE id=$3 AND counter=$4 AND revoked_at IS NULL RETURNING id',[result.authenticationInfo.newCounter,result.authenticationInfo.credentialBackedUp,credential.id,credential.counter]);
    if(!updated.rows.length) fail(401,'認証をやり直してください');
    // Re-check suspension after the cryptographic verification.
    const user=await one(db,"SELECT id FROM users WHERE id=$1 AND status='active'",[credential.user_id]);
    if(!user) fail(401,'アカウントが停止されています');
    await session(req,reply,user.id); await audit(db,user.id,'login','user',user.id); return {ok:true};
  },{auth:false,limit:20});
  route('POST','/api/auth/logout',{},[],async(req,reply)=>{
    await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[hash(req.cookies.session||'')]);
    reply.clearCookie('session',cookieOptions).clearCookie('csrf',cookieOptions); return {ok:true};
  });
  route('GET','/api/me',null,[],async req=>({user:req.user,contact:c.contact,p2p:c.p2p,maxAlbumBytes:c.maxAlbum}));
  route('GET','/api/me/passkeys',null,[],async req=>(await db.query('SELECT id,device_type,backup_state,created_at FROM passkey_credentials WHERE user_id=$1 AND revoked_at IS NULL',[req.user.id])).rows);
  route('POST','/api/me/passkeys/options',{},[],async(req,reply)=>{
    const credentials=(await db.query('SELECT id,transports FROM passkey_credentials WHERE user_id=$1 AND revoked_at IS NULL',[req.user.id])).rows;
    return challenge(req,reply,'add-key',await generateRegistrationOptions({rpName:'あわせ便',rpID:c.rpID,userName:req.user.display_name,userID:Buffer.from(req.user.id),attestationType:'none',excludeCredentials:credentials,authenticatorSelection:{residentKey:'required',userVerification:'required'}}),null,req.user.id);
  });
  route('POST','/api/me/passkeys/verify',{response:{type:'object',additionalProperties:true}},['response'],async(req,reply)=>{
    const ch=await consume(req,reply,'add-key'); if(ch.user_id!==req.user.id) fail(403,'認証が一致しません');
    const result=await verifyRegistrationResponse({response:req.body.response,expectedChallenge:ch.challenge,expectedOrigin:c.origin,expectedRPID:c.rpID,requireUserVerification:true});
    if(!result.verified) fail(401,'検証に失敗しました');
    const i=result.registrationInfo; await saveCredential(db,req.user.id,i.credential,i.credentialBackedUp,i.credentialDeviceType);
    await audit(db,req.user.id,'passkey.add','user',req.user.id); return {ok:true};
  });
  route('POST','/api/me/passkeys/revoke',{id:{type:'string',maxLength:2048}},['id'],async req=>{
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
      const count=await one(tx,'SELECT count(*) AS n FROM passkey_credentials WHERE user_id=$1 AND revoked_at IS NULL',[req.user.id]);
      if(Number(count.n)<=1) fail(409,'最後のパスキーは失効できません');
      await tx.query('UPDATE passkey_credentials SET revoked_at=now() WHERE id=$1 AND user_id=$2',[req.body.id,req.user.id]);
      await audit(tx,req.user.id,'passkey.revoke','user',req.user.id);
    }); return {ok:true};
  });
  route('POST','/api/admin/invitations',{displayName:{type:'string',minLength:1,maxLength:80},role:{type:'string',enum:['admin','uploader']},days:{type:'integer',minimum:1,maximum:7}},['displayName','role'],async req=>{
    const value=token(), id=randomUUID();
    await db.query('INSERT INTO invitations(id,token_hash,role,display_name,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,hash(value),req.body.role,req.body.displayName,new Date(Date.now()+(req.body.days||1)*86400000),req.user.id]);
    await audit(db,req.user.id,'invitation.create','invitation',id); return {id,url:`${c.origin}/invite/${value}`};
  },{admin:true});
  route('GET','/api/admin/invitations',null,[],async()=> (await db.query('SELECT id,display_name,role,expires_at,used_at,revoked_at,attempts FROM invitations ORDER BY expires_at DESC LIMIT 100')).rows,{admin:true});
  route('POST','/api/admin/invitations/:id/revoke',{},[],async req=>{
    await db.query('UPDATE invitations SET revoked_at=now() WHERE id=$1',[req.params.id]); await audit(db,req.user.id,'invitation.revoke','invitation',req.params.id); return {ok:true};
  },{admin:true});
  route('GET','/api/admin/users',null,[],async()=> (await db.query('SELECT id,display_name,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 200')).rows,{admin:true});
  for (const action of ['suspend','recover']) route('POST',`/api/admin/users/:id/${action}`,{},[],async req=>{
    if(req.params.id===req.user.id) fail(409,'自分自身は停止できません');
    const value=token(), id=randomUUID();
    await db.transaction(async tx=>{
      const user=await one(tx,"UPDATE users SET status='suspended' WHERE id=$1 RETURNING *",[req.params.id]); if(!user) fail(404,'ユーザーが見つかりません');
      await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1',[user.id]);
      await tx.query('UPDATE passkey_credentials SET revoked_at=now() WHERE user_id=$1',[user.id]);
      await tx.query('UPDATE invitations SET revoked_at=now() WHERE recovery_user_id=$1 AND used_at IS NULL',[user.id]);
      if(action==='recover') await tx.query('INSERT INTO invitations(id,token_hash,role,display_name,recovery_user_id,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,hash(value),user.role,user.display_name,user.id,new Date(Date.now()+86400000),req.user.id]);
      await audit(tx,req.user.id,`user.${action}`,'user',user.id);
    }); return action==='recover'? {url:`${c.origin}/invite/${value}`} : {ok:true};
  },{admin:true});
  route('GET','/api/admin/audit',null,[],async()=> (await db.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 200')).rows,{admin:true});
}
async function saveCredential(db,userId,credential,backedUp,deviceType) {
  await db.query('INSERT INTO passkey_credentials(id,user_id,public_key,counter,transports,backup_state,device_type) VALUES($1,$2,$3,$4,$5,$6,$7)',[credential.id,userId,Buffer.from(credential.publicKey),credential.counter,JSON.stringify(credential.transports||[]),backedUp,deviceType]);
}
