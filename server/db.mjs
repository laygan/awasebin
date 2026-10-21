import pg from 'pg';
import { readFile } from 'node:fs/promises';
export function database(url) {
  const pool = new pg.Pool({connectionString:url,max:10});
  return { query:(s,p)=>pool.query(s,p), close:()=>pool.end(), transaction: async fn => {
    const c = await pool.connect(); try { await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result; }
    catch(e){ await c.query('ROLLBACK'); throw e; } finally {c.release();}
  }};
}
export async function migrate(db) { await db.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8')); }
export async function one(db,sql,args=[]) { return (await db.query(sql,args)).rows[0]; }
export async function audit(db,actor,action,type,id,result='success') {
  await db.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,result) VALUES($1,$2,$3,$4,$5)',[actor,action,type,id,result]);
}
