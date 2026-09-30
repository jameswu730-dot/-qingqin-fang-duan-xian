import crypto from 'node:crypto';
import {assess,rules,shouldNotify,alertText,labels} from './radar.js';
import {commands,linkFor} from './commands.js';
export const DAY=86400000;
export function fallback(text,history=[],allowQuestion=true) {
  const a=rules(text,history);
  if(a.urgent) return '這個情況請盡快找身旁可信任的人協助；若有立即危險，請直接聯絡當地緊急服務。這個小幫手無法提供緊急救援。';
  if(/休息|晚安|不想聊|不要問/.test(text)) return '好，先好好休息，有需要也可以直接找家人聊聊。';
  if(a.category==='sleep') return allowQuestion?'睡不好會很累。最近是難入睡，還是半夜醒來呢？':'先好好休息，也可以找家人說說最近睡眠的情況。';
  if(a.category!=='none') return allowQuestion?'謝謝你告訴我，現在這個情況還持續嗎？':'我記下這個近況了。有需要時，請直接找家人協助。';
  return '謝謝你分享今天的近況，祝你今天過得順心。';
}
export async function enqueue(c,{eventId,kind,destination,content,familyId=null,radarId=null,level=null,now}) {
  if(!destination) return;
  await c.query(`INSERT INTO notification_outbox(id,event_id,kind,destination,content,family_id,radar_id,level,created_at,next_attempt_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10) ON CONFLICT DO NOTHING`,
  [crypto.randomUUID(),eventId,kind,destination,content,familyId,radarId,level,now,new Date(+now+(kind==='reply'?60000:23*3600000))]);
}
export async function handle(c,event,{now=new Date(),analyze=async()=>null}={}) {
  const userId=event.source.userId,text=event.message.text.trim(),eventId=event.webhookEventId;
  let family=await linkFor(c,userId),reply;
  const command=await commands(c,{userId,text,eventId,family,now});
  if(command) {
    reply=command.reply;
    if(command.unlinked) family=null;
    if(command.family) family=command.family;
    if(command.notice) await enqueue(c,{eventId,kind:'push',...command.notice,familyId:family?.id,now});
  } else if(text==='查看雷達') {
    if(!family) reply='請先完成家人配對。';
    else {
      const ev=(await c.query("SELECT * FROM radar_events WHERE family_id=$1 AND status='open' AND expires_at>$2 ORDER BY last_seen DESC LIMIT 5",[family.id,now])).rows;
      reply=ev.length?ev.map(e=>`${{green:'🟢',yellow:'🟡',red:'🔴'}[e.level]} ${labels[e.category]}：${e.level==='green'?'單次訊號，暫不通知':'值得親自關心'}`).join('\n'):'🟢 目前沒有持續中的關懷事件。這不代表沒有需要關心的事情。';
    }
  } else if(!family) reply='我是 AI 關懷小幫手。請先傳「建立配對」並由家人確認，或傳「說明」了解服務。';
  else if(family.child_line_user_id===userId) reply='你可以傳「本週關心 最近散步還順利嗎」，或傳「說明」查看其他指令。';
  else reply=await conversation(c,family,text,eventId,{now,analyze});
  await enqueue(c,{eventId,kind:'reply',destination:event.replyToken,content:reply,familyId:family?.id,now});
  return reply;
}
async function conversation(c,family,text,eventId,{now,analyze}) {
  const history=(await c.query('SELECT speaker,message,created_at FROM messages WHERE family_id=$1 AND created_at>$2 AND expires_at>$3 ORDER BY created_at DESC,id DESC LIMIT 20',[family.id,new Date(+now-14*DAY),now])).rows.reverse();
  const profile=(await c.query('SELECT nickname,chat_style,topics,interests,background,avoid_topics FROM care_profiles WHERE family_id=$1',[family.id])).rows[0]||{};
  await c.query("UPDATE radar_events SET status='resolved' WHERE family_id=$1 AND last_seen<$2",[family.id,new Date(+now-14*DAY)]);
  const events=(await c.query("SELECT * FROM radar_events WHERE family_id=$1 AND status='open'",[family.id])).rows;
  const tasks=(await c.query("SELECT * FROM care_tasks WHERE family_id=$1 AND expires_at>$2 AND status IN ('pending','asked') ORDER BY id",[family.id,now])).rows;
  const lastAssistant=history.filter(m=>m.speaker==='assistant').at(-1);
  const localCategory=rules(text,history).category;
  const taboo=(profile.avoid_topics||[]).some(t=>text.includes(t) || (labels[localCategory]||'').includes(t));
  const allowQuestion=!taboo && !/[?？]/.test(lastAssistant?.message||'') && !/不要問|不想說|不想聊|晚安|休息/.test(text);
  const lastAsked=(await c.query('SELECT max(asked_at) AS at FROM care_tasks WHERE family_id=$1',[family.id])).rows[0].at;
  const eligible=allowQuestion && (!lastAsked || now-new Date(lastAsked)>=DAY)?tasks.find(t=>t.status==='pending' && !(profile.avoid_topics||[]).some(a=>t.topic.includes(a))):null;
  const dailyCount=Number((await c.query("SELECT count(*) AS n FROM messages WHERE family_id=$1 AND speaker='parent' AND created_at>$2",[family.id,new Date(+now-DAY)])).rows[0].n);
  let analysis=null;
  if(dailyCount<30) analysis=await analyze({text,history,profile,events,allowQuestion,eligibleTask:eligible?{id:String(eligible.id),topic:eligible.topic}:null,askedTasks:tasks.filter(t=>t.status==='asked').map(t=>({id:String(t.id),topic:t.topic}))});
  let reply=analysis?.reply || fallback(text,history,allowQuestion);
  const initial=assess({text,history,analysis,now});
  const category=initial?.category||analysis?.category||rules(text,history).category;
  let previous=events.find(e=>e.category===category);
  const event=assess({text,history,analysis,previous,now});
  if(event) {
    if(event.resolved) {
      await c.query("UPDATE radar_events SET status='resolved',level='green',last_seen=$2 WHERE id=$1",[event.id,now]);
      await c.query("UPDATE notification_outbox SET status='cancelled',destination=NULL,content=NULL WHERE radar_id=$1 AND status='pending'",[event.id]);
    } else {
      const params=[family.id,event.category,event.level,event.first_seen,now,event.signal_days,event.occurrences,event.reason,new Date(+now+90*DAY),event.reported_days];
      const saved=(await c.query(`INSERT INTO radar_events(family_id,category,level,first_seen,last_seen,signal_days,occurrences,reason,expires_at,reported_days)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(family_id,category) WHERE status='open' DO UPDATE SET level=$3,last_seen=$5,signal_days=$6,occurrences=$7,reason=$8,expires_at=$9,reported_days=$10 RETURNING *`,params)).rows[0];
      if(saved.level==='red') reply=fallback('喘不過氣',history,false);
      const latest=(await c.query('SELECT max(last_notified_at) AS at FROM radar_events WHERE family_id=$1',[family.id])).rows[0].at;
      if(saved.level==='red') await c.query("UPDATE notification_outbox SET status='cancelled',destination=NULL,content=NULL WHERE radar_id=$1 AND status='pending' AND level='yellow'",[saved.id]);
      const pending=(await c.query("SELECT id FROM notification_outbox WHERE family_id=$1 AND status='pending' AND radar_id IS NOT NULL AND ($2<>'red' OR level='red')",[family.id,saved.level])).rows.length>0;
      if(shouldNotify(saved,latest,pending,now)) await enqueue(c,{eventId,kind:'push',destination:family.child_line_user_id,content:alertText(saved),familyId:family.id,radarId:saved.id,level:saved.level,now});
    }
  }
  await c.query("INSERT INTO messages(family_id,speaker,message,event_id,created_at,expires_at) VALUES($1,'parent',$2,$3,$4,$5),($1,'assistant',$6,$3,$4,$5) ON CONFLICT DO NOTHING",[family.id,text,eventId,now,new Date(+now+30*DAY),reply]);
  if(eligible && String(eligible.id)===analysis?.askedTaskId) await c.query("UPDATE care_tasks SET status='asked',asked_at=$2 WHERE id=$1",[eligible.id,now]);
  const answered=tasks.find(t=>t.status==='asked' && String(t.id)===analysis?.answeredTaskId);
  if(answered) await c.query("UPDATE care_tasks SET status='answered',answered_at=$2 WHERE id=$1",[answered.id,now]);
  return reply;
}
