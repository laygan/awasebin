const string={type:'string'},integer={type:'integer'},bool={type:'boolean'},date={type:'string',format:'date-time'};
const object=properties=>({type:'object',properties,additionalProperties:true});
const list=items=>({type:'array',items});
const album=object({id:{...string,format:'uuid'},owner_id:{...string,format:'uuid'},title:string,status:{type:'string',enum:['draft','uploading','processing','published','expired','revoked','deleted']},total_bytes:{anyOf:[integer,string]},expires_at:date,created_at:date});
const file=object({id:string,original_name:string,size_bytes:{anyOf:[integer,string]},sha256:{type:'string',nullable:true},state:string,preview:bool});
export function successSchema(method,url){
 if(method==='GET' && /\/files\/:fileId$/.test(url))return {type:'string',format:'binary'};
 if(method==='GET' && /\/previews\/:fileId$/.test(url))return {type:'string',format:'binary'};
 if(method==='GET' && ['/api/me/passkeys','/api/admin/invitations','/api/admin/users','/api/admin/audit'].includes(url))return list({type:'object',additionalProperties:true});
 if(method==='GET' && url==='/api/albums')return object({albums:list(album)});
 if(method==='GET' && url==='/api/albums/:id')return object({album,files:list(file),jobs:list({type:'object',additionalProperties:true})});
 if(method==='GET' && url==='/api/s/:shareToken')return object({title:string,totalBytes:{anyOf:[integer,string]},expiresAt:date,files:list(file),p2p:bool,contact:string});
 if(url.endsWith('/options'))return object({challenge:string,timeout:integer,rpId:string,userVerification:string});
 if(url.endsWith('/upload-authorizations'))return object({fileId:string,jobId:string,token:string,expiresAt:date,endpoint:string});
 if(url.endsWith('/peer-session'))return object({infoHash:string,announce:string,iceServers:list(object({urls:string})),turnEnabled:bool,expiresIn:integer});
 if(url==='/api/me')return object({user:object({id:string,display_name:string,role:string,status:string}),contact:string,p2p:bool,maxAlbumBytes:integer});
 if(url.endsWith('/publish') || (method==='POST' && (url==='/api/admin/invitations' || url.endsWith('/recover'))))return object({id:string,url:string});
 if(url==='/api/albums' && method==='POST')return object({id:string});
 if(method==='POST')return object({ok:bool});
 return {type:'object',additionalProperties:true};
}
