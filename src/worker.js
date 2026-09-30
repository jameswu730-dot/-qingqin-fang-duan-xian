import {transaction,safeLog} from './db.js';
import {handle,DAY} from './care.js';
export function createWorker(pool,{analyze,line,clock=()=>new Date()}={}) {
  let busy=false;
  async function processOne() {
    let eventId;
    try {
      return await transaction(pool,async c=>{
        const now=clock();
        const item=(await c.query("SELECT * FROM webhook_inbox WHERE status='pending' AND next_attempt_at<=$1 ORDER BY received_at,event_id LIMIT 1 FOR UPDATE",[now])).rows[0];
        if(!item) return false;
        eventId=item.event_id;
        if(now-new Date(item.received_at)>DAY) {await c.query("UPDATE webhook_inbox SET status='failed',payload=NULL,source_id=NULL WHERE event_id=$1",[eventId]);return true;}
        await handle(c,item.payload,{now,analyze});
        await c.query("UPDATE webhook_inbox SET status='done',payload=NULL,source_id=NULL WHERE event_id=$1",[eventId]);
        return true;
      });
    } catch(e) {
      safeLog('inbox_processing_failed',e);
      if(eventId) await pool.query("UPDATE webhook_inbox SET attempts=attempts+1,next_attempt_at=$2,status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,payload=CASE WHEN attempts>=4 THEN NULL ELSE payload END,source_id=CASE WHEN attempts>=4 THEN NULL ELSE source_id END WHERE event_id=$1",[eventId,new Date(+clock()+60000)]);
      return false;
    }
  }
  async function sendOne() {
    return transaction(pool,async c=>{
      const now=clock();
      const item=(await c.query("SELECT * FROM notification_outbox WHERE status='pending' AND next_attempt_at<=$1 ORDER BY CASE WHEN level='red' THEN 0 ELSE 1 END,created_at LIMIT 1 FOR UPDATE",[now])).rows[0];
      if(!item) return false;
      let valid=new Date(item.expires_at)>now;
      if(item.radar_id) {
        const f=(await c.query('SELECT child_line_user_id FROM family_links WHERE id=$1 AND revoked_at IS NULL',[item.family_id])).rows[0];
        const e=(await c.query('SELECT status FROM radar_events WHERE id=$1',[item.radar_id])).rows[0];
        valid=valid && f?.child_line_user_id===item.destination && e?.status==='open';
      }
      if(!valid) {await c.query("UPDATE notification_outbox SET status='cancelled',destination=NULL,content=NULL WHERE id=$1",[item.id]);return true;}
      try {
        await line(item.kind,item.destination,item.content,item.id);
        await c.query("UPDATE notification_outbox SET status='sent',sent_at=$2,destination=NULL,content=NULL WHERE id=$1",[item.id,now]);
        if(item.radar_id) await c.query('UPDATE radar_events SET last_notified_at=$2,last_notified_level=$3 WHERE id=$1',[item.radar_id,now,item.level]);
      } catch(e) {
        safeLog('line_delivery_failed',e);
        const retry=e.retryable!==false && item.attempts<7;
        await c.query("UPDATE notification_outbox SET attempts=attempts+1,status=$2,next_attempt_at=$3,destination=CASE WHEN $2='failed' THEN NULL ELSE destination END,content=CASE WHEN $2='failed' THEN NULL ELSE content END WHERE id=$1",[item.id,retry?'pending':'failed',new Date(+now+Math.min(60,2**item.attempts)*60000)]);
      }
      return true;
    });
  }
  async function cleanup() {
    const now=clock();
    await transaction(pool,async c=>{
      await c.query('DELETE FROM messages WHERE expires_at<=$1',[now]);
      await c.query('DELETE FROM radar_events WHERE expires_at<=$1',[now]);
      await c.query('DELETE FROM care_tasks WHERE expires_at<=$1',[now]);
      await c.query('DELETE FROM pairing_requests WHERE expires_at<=$1',[now]);
      await c.query('DELETE FROM pairing_limits WHERE window_start<$1',[new Date(+now-DAY)]);
      await c.query('DELETE FROM ai_usage WHERE day<$1',[new Date(+now-90*DAY)]);
      await c.query("UPDATE webhook_inbox SET status='failed',payload=NULL,source_id=NULL WHERE status='pending' AND received_at<$1",[new Date(+now-DAY)]);
      await c.query('DELETE FROM webhook_inbox WHERE expires_at<=$1',[now]);
      await c.query("UPDATE notification_outbox SET status='cancelled',destination=NULL,content=NULL WHERE status='pending' AND expires_at<=$1",[now]);
      await c.query("DELETE FROM notification_outbox WHERE status<>'pending' AND created_at<$1",[new Date(+now-30*DAY)]);
      await c.query('DELETE FROM family_links WHERE revoked_at<$1',[new Date(+now-30*DAY)]);
    });
  }
  return {processOne,sendOne,cleanup,async tick(){
    if(busy) return; busy=true;
    try {for(let i=0;i<10;i++){const a=await processOne();const b=await sendOne();if(!a&&!b)break;}}
    catch(e){safeLog('worker_failed',e);}finally{busy=false;}
  }};
}
