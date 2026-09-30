import express from 'express';
import crypto from 'node:crypto';
import {safeLog} from './db.js';
export function verifyLineSignature(req,secret) {
  const signature=req.headers['x-line-signature'];
  if(!secret || typeof signature!=='string' || !req.rawBody) return false;
  const expected=crypto.createHmac('sha256',secret).update(req.rawBody).digest();
  let received; try {received=Buffer.from(signature,'base64');} catch{return false;}
  return received.length===expected.length && crypto.timingSafeEqual(received,expected);
}
export function createApp({pool,secret,wake=()=>{}}) {
  const app=express();
  app.disable('x-powered-by');
  app.use(express.json({limit:'256kb',verify:(req,_res,buf)=>{req.rawBody=buf;}}));
  app.get('/',(_req,res)=>res.type('text').send('親情防斷線 V1 封閉測試版。家庭資料查詢不開放；請使用 LINE 指令。'));
  app.get('/api/family/:userId',(_req,res)=>res.status(403).json({error:'查詢功能不開放'}));
  app.get('/healthz',async(_req,res)=>{
    try {await pool.query('SELECT 1');res.json({ok:true,version:'1.0.0'});}
    catch {res.status(503).json({ok:false});}
  });
  app.get('/db-test',(_req,res)=>res.status(403).json({error:'請使用健康狀態端點'}));
  app.post('/webhook',async(req,res)=>{
    if(!verifyLineSignature(req,secret)) return res.status(401).send('invalid signature');
    if(!Array.isArray(req.body?.events) || req.body.events.length>100) return res.sendStatus(400);
    const c=await pool.connect().catch(()=>null);
    if(!c) return res.sendStatus(503);
    try {
      await c.query('BEGIN');
      for(const e of req.body.events) {
        if(e.type!=='message' || e.message?.type!=='text' || e.source?.type!=='user' || typeof e.source.userId!=='string' || typeof e.message.text!=='string') continue;
        // LINE message ID is a stable fallback when a legacy event has no webhookEventId.
        const id=e.webhookEventId || e.message.id;
        if(typeof id!=='string' || id.length>200 || typeof e.replyToken!=='string') continue;
        const payload={type:'message',webhookEventId:id,replyToken:e.replyToken,source:{type:'user',userId:e.source.userId},message:{type:'text',text:e.message.text.slice(0,2000)},timestamp:e.timestamp};
        await c.query('INSERT INTO webhook_inbox(event_id,source_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,e.source.userId,JSON.stringify(payload)]);
      }
      await c.query('COMMIT');
      res.sendStatus(200); // Acknowledge only after durable acceptance.
      wake();
    } catch(e) {await c.query('ROLLBACK');safeLog('webhook_persist_failed',e);res.sendStatus(503);}
    finally {c.release();}
  });
  app.use((err,_req,res,_next)=>{safeLog('http_request_failed',err);res.sendStatus(err?.type==='entity.too.large'?413:400);});
  return app;
}
