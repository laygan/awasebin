import {spawn} from 'node:child_process';
import {mkdir,open,unlink} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
const directory=process.env.BACKUP_DIR,recipient=process.env.BACKUP_RECIPIENT;
if(!directory || !path.isAbsolute(directory) || !recipient)throw new Error('Set absolute BACKUP_DIR and age BACKUP_RECIPIENT');
if(!process.env.DATABASE_URL || !process.env.DATA_ROOT)throw new Error('Database/storage configuration required');
await mkdir(directory,{recursive:true,mode:0o700});
const db=new URL(process.env.DATABASE_URL),stamp=new Date().toISOString().replace(/[:.]/g,'-');
const pgEnv={...process.env,PGHOST:db.hostname,PGPORT:db.port||'5432',PGUSER:decodeURIComponent(db.username),PGPASSWORD:decodeURIComponent(db.password),PGDATABASE:decodeURIComponent(db.pathname.slice(1))};
function completion(child){return new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error('Backup subprocess could not start')));child.once('exit',code=>code===0?resolve():reject(new Error('Backup subprocess failed')));});}
async function encrypt(command,args,suffix,env=process.env){
 const filename=path.join(directory,`${stamp}-${suffix}.age`),file=await open(filename,'wx',0o600);
 const source=spawn(command,args,{env,stdio:['ignore','pipe','ignore']}),age=spawn('age',['--encrypt','--recipient',recipient],{stdio:['pipe','pipe','ignore']});
 try{await Promise.all([completion(source),completion(age),pipeline(source.stdout,age.stdin),pipeline(age.stdout,file.createWriteStream())]);}
 catch(e){source.kill();age.kill();await file.close().catch(()=>{});await unlink(filename).catch(()=>{});throw e;}
}
await encrypt('pg_dump',['--format=custom'],'database',pgEnv);
await encrypt('tar',['-C','/','-cf','-','etc/cosshare','etc/letsencrypt',path.relative('/',path.join(process.env.DATA_ROOT,'torrents'))],'configuration');
console.log('Encrypted database and configuration backups completed; original photos excluded');
