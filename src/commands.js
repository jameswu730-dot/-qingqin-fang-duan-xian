import crypto from 'node:crypto';
export const HELP='我是 AI 關懷小幫手，不是家人本人，不提供醫療診斷或緊急救援。\nAI啟用時，必要的近期訊息、關懷檔案及任務會由OpenAI API處理；不附LINE身分識別碼。對話在本系統保留30天；OpenAI仍可能依其政策保留安全稽核紀錄。子女只收到分類提醒，不預設分享原文。\n配對：建立配對／加入配對 六位碼／確認配對 六位碼\n子女設定：設定稱呼 媽媽；設定聊天習慣 慢慢聊；設定題材 園藝、做菜；設定興趣 散步；設定留意 睡眠；設定禁問 體重\n本週關心 最近散步還順利嗎（最多3項，7天到期）\n查看設定／查看任務／取消任務 編號／查看雷達\n解除綁定：立即停止家庭提醒；歷史關懷資料30天後清理。';
const fields={稱呼:'nickname',聊天習慣:'chat_style',題材:'topics',興趣:'interests',留意:'background',禁問:'avoid_topics'};
export async function linkFor(c,id) {
  return (await c.query('SELECT * FROM family_links WHERE revoked_at IS NULL AND (parent_line_user_id=$1 OR child_line_user_id=$1)',[id])).rows[0];
}
export async function commands(c,{userId,text,family,eventId,now}) {
  const isChild=family?.child_line_user_id===userId;
  await c.query('DELETE FROM pairing_requests WHERE expires_at<=$1',[now]);
  if(/^(建立配對|加入配對|確認配對)/.test(text)) {
    const hash=crypto.createHash('sha256').update(userId).digest('hex');
    const previous=(await c.query('SELECT * FROM pairing_limits WHERE actor_hash=$1',[hash])).rows[0];
    if(previous && now-new Date(previous.window_start)<600000 && previous.attempts>=10) return {reply:'配對嘗試太頻繁，請10分鐘後再試。'};
    await c.query('INSERT INTO pairing_limits(actor_hash,window_start,attempts) VALUES($1,$2,$3) ON CONFLICT(actor_hash) DO UPDATE SET window_start=$2,attempts=$3',[hash,previous && now-new Date(previous.window_start)<600000?previous.window_start:now,previous && now-new Date(previous.window_start)<600000?previous.attempts+1:1]);
  }
  if(text==='解除綁定') {
    await c.query('DELETE FROM pairing_requests WHERE parent_id=$1 OR child_id=$1',[userId]);
    if(!family) return {reply:'目前沒有家人綁定，待確認配對也已取消。'};
    await c.query('UPDATE family_links SET revoked_at=$2 WHERE id=$1',[family.id,now]);
    await c.query("UPDATE notification_outbox SET status='cancelled',destination=NULL,content=NULL WHERE family_id=$1 AND status='pending'",[family.id]);
    // Cancel work queued under the old relationship; preserve idempotency tombstones.
    await c.query("UPDATE webhook_inbox SET status='done',payload=NULL,source_id=NULL WHERE source_id=ANY($1::text[]) AND event_id<>$2",[[family.parent_line_user_id,family.child_line_user_id],eventId]);
    return {reply:'已解除家人綁定，立即停止家庭雷達提醒。這組關係的歷史關懷資料將在30天後清理。',unlinked:true,
      notice:{destination:isChild?family.parent_line_user_id:family.child_line_user_id,content:'家人綁定已由另一方解除，之後不會再收到家庭雷達提醒。歷史關懷資料將在30天後清理。'}};
  }
  if(text==='建立配對') {
    if(family) return {reply:'你已有家人綁定。如需重新配對，請先傳「解除綁定」。'};
    await c.query('DELETE FROM pairing_requests WHERE parent_id=$1 OR child_id=$1',[userId]);
    let code; do {code=String(crypto.randomInt(100000,1000000));} while((await c.query('SELECT code FROM pairing_requests WHERE code=$1',[code])).rows.length);
    await c.query('INSERT INTO pairing_requests(code,parent_id,expires_at) VALUES($1,$2,$3)',[code,userId,new Date(+now+600000)]);
    return {reply:`配對碼：${code}\n10 分鐘內請子女傳「加入配對 ${code}」。收到申請後，你還需要親自確認。請只把配對碼交給你信任的家人。`};
  }
  if(/^加入配對\s+[0-9]{6}$/.test(text)) {
    const code=text.slice(-6),p=(await c.query('SELECT * FROM pairing_requests WHERE code=$1',[code])).rows[0];
    if(family) return {reply:'你已有家人綁定，請先解除綁定。'};
    if(!p || p.parent_id===userId || p.child_id) return {reply:'配對碼無效、已過期，或不能用同一個帳號配對。'};
    await c.query('UPDATE pairing_requests SET child_id=$1 WHERE code=$2',[userId,code]);
    return {reply:'配對申請已送出，等待父母帳號確認。尚未建立綁定。',notice:{destination:p.parent_id,content:`收到一筆配對申請。若確定是家人，請在配對碼原有效期限內傳「確認配對 ${code}」；否則請忽略。`}};
  }
  if(/^確認配對\s+[0-9]{6}$/.test(text)) {
    const code=text.slice(-6),p=(await c.query('SELECT * FROM pairing_requests WHERE code=$1',[code])).rows[0];
    if(!p || p.parent_id!==userId || !p.child_id) return {reply:'找不到等待你確認的有效配對申請。'};
    if(family || await linkFor(c,p.child_id)) {await c.query('DELETE FROM pairing_requests WHERE code=$1',[code]);return {reply:'其中一個帳號已有綁定，請先解除再配對。'};}
    const linked=(await c.query('INSERT INTO family_links(parent_line_user_id,child_line_user_id) VALUES($1,$2) RETURNING *',[userId,p.child_id])).rows[0];
    await c.query('DELETE FROM pairing_requests WHERE parent_id=ANY($1::text[]) OR child_id=ANY($1::text[])',[[userId,p.child_id]]);
    return {family:linked,reply:'✅ 家人綁定完成。我是 AI 關懷小幫手，不是家人本人。對話保留30天，提醒不含原文。傳「說明」了解資料使用；傳「解除綁定」可停止提醒。',notice:{destination:p.child_id,content:'✅ 家人綁定完成。值得關心時會提供分類提醒，不預設分享原文。傳「說明」查看關懷設定方式。'}};
  }
  if(['說明','幫助'].includes(text)) return {reply:HELP};
  if(text.startsWith('設定')) {
    const m=text.match(/^設定(稱呼|聊天習慣|題材|興趣|留意|禁問)\s+(.+)$/s);
    if(!isChild) return {reply:'請由已綁定的子女帳號設定。'};
    if(!m || m[2].length>200) return {reply:'請使用「設定稱呼 媽媽」等指令，每項最多200字。傳「說明」查看欄位。'};
    const field=fields[m[1]],value=m[2]==='清除'?'':m[2];
    const v=['nickname','chat_style'].includes(field)?value:value.split(/[、,，\n]/).map(x=>x.trim()).filter(Boolean).slice(0,8);
    // Column name is exclusively from the fixed allowlist above, never user SQL.
    await c.query(`INSERT INTO care_profiles(family_id,${field},updated_at) VALUES($1,$2,$3) ON CONFLICT(family_id) DO UPDATE SET ${field}=$2,updated_at=$3`,[family.id,v,now]);
    return {reply:`已更新${m[1]}。傳「查看設定」可檢查。`};
  }
  if(text==='查看設定') {
    if(!family) return {reply:'請先完成家人配對。'};
    const p=(await c.query('SELECT * FROM care_profiles WHERE family_id=$1',[family.id])).rows[0]||{};
    return {reply:Object.entries(fields).map(([name,k])=>`${name}：${Array.isArray(p[k])?p[k].join('、'):p[k]||'未設定'}`).join('\n')};
  }
  if(text.startsWith('本週關心 ')) {
    const topic=text.slice(5).trim();
    if(!isChild) return {reply:'請由已綁定的子女帳號設定。'};
    if(!topic || topic.length>200) return {reply:'請輸入1至200字的關懷事項。'};
    const active=(await c.query("SELECT id FROM care_tasks WHERE family_id=$1 AND expires_at>$2 AND status IN ('pending','asked')",[family.id,now])).rows;
    if(active.length>=3) return {reply:'最多3個未完成事項，請先取消或等待到期。'};
    await c.query('INSERT INTO care_tasks(family_id,topic,created_at,expires_at) VALUES($1,$2,$3,$4)',[family.id,topic,now,new Date(+now+7*86400000)]);
    return {reply:'已加入本週關懷，7天後到期。會依情境自然帶入，不保證一定詢問，也不會連續盤問。'};
  }
  if(text==='查看任務') {
    if(!family) return {reply:'請先完成家人配對。'};
    const tasks=(await c.query('SELECT * FROM care_tasks WHERE family_id=$1 AND expires_at>$2 ORDER BY id',[family.id,now])).rows;
    return {reply:tasks.length?tasks.map(t=>`${t.id}｜${t.topic}｜${{pending:'待關心',asked:'已問',answered:'已回覆',cancelled:'已取消'}[t.status]}`).join('\n'):'目前沒有本週關懷事項。'};
  }
  if(/^取消任務\s+\d+$/.test(text)) {
    if(!isChild) return {reply:'請由已綁定的子女帳號操作。'};
    const q=await c.query("UPDATE care_tasks SET status='cancelled' WHERE family_id=$1 AND id=$2 RETURNING id",[family.id,text.match(/\d+$/)[0]]);
    return {reply:q.rows.length?'已取消。':'找不到這組家庭的任務。'};
  }
  return null;
}
