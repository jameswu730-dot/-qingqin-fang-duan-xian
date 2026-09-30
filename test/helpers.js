import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export async function database(path) {
  const pg=new PGlite(path);
  await pg.waitReady;
  const query=async(sql,params)=>{
    // PGlite is single-session; cross-session advisory locking is tested separately on deployment.
    if(sql.includes('pg_advisory_xact_lock')) return {rows:[]};
    return pg.query(sql,params);
  };
  const pool={query,connect:async()=>({query,release(){}}),end:()=>pg.close(),pg};
  await pg.exec(await readFile(new URL('../migrations/001_v1.sql',import.meta.url),'utf8'));
  return pool;
}
export function message(user,text,id=randomUUID()) {
  return {webhookEventId:id,replyToken:`reply-${id}`,source:{type:'user',userId:user},type:'message',message:{type:'text',text,id}};
}
