import {randomUUID} from 'node:crypto';
import {config} from './config.mjs';
import {database,migrate,one} from './db.mjs';
import {token,hash} from './security.mjs';
import {cleanup} from './maintenance.mjs';
const c=config(),db=database(c.databaseURL);
try {
  const command=process.argv[2];
  if(command==='migrate') {await migrate(db);console.log('Schema initialized');}
  else if(command==='bootstrap') {
    const value=token();
    await db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(887702)');
      const admins=await one(tx,"SELECT count(*) AS n FROM users WHERE role='admin'");
      if(Number(admins.n)>0) throw new Error('An administrator already exists; use the authenticated recovery workflow');
      await tx.query("UPDATE invitations SET revoked_at=now() WHERE role='admin' AND used_at IS NULL");
      await tx.query("INSERT INTO invitations(id,token_hash,role,display_name,expires_at) VALUES($1,$2,'admin',$3,$4)",[randomUUID(),hash(value),process.argv[3]||'管理者',new Date(Date.now()+3600000)]);
    });
    console.log(`One-use bootstrap link (1 hour; deliver privately):\n${c.origin}/invite/${value}`);
  } else if(command==='cleanup') {await cleanup(db,c);console.log('Cleanup completed');}
  else throw new Error('Usage: cli.mjs migrate | bootstrap [display name] | cleanup');
} finally {await db.close();}
