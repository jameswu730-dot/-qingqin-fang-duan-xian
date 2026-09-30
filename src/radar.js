export const categories = ['sleep','physical','mood','daily','safety'];
export const labels = {sleep:'睡眠與精神',physical:'身體不適',mood:'情緒與社交',daily:'生活作息',safety:'人身安全'};
export const reasons = {repeated:'近期不同日期反覆提到相關變化',duration:'家人表示這個變化已持續一段時間',background:'相關變化反覆出現，也與預先設定的關注事項有關',urgent:'訊息出現可能需要盡快由真人確認的內容',single:'目前只有單次訊號，暫不主動通知'};
const terms = {sleep:/睡不好|失眠|半夜.{0,5}醒|沒精神|難入睡|睡不著/,physical:/疼|痛|不舒服|頭暈|暈眩/,mood:/孤單|難過|心情不好|不想見人|很低落/,daily:/沒吃飯|吃不下|沒胃口|不想出門/,safety:/跌倒|摔倒|起不來|爬不起|喘不過氣|呼吸困難|不想活|想自殺/};
export function rules(text, history=[]) {
  const clauses=text.split(/[，。！？\n]/).filter(s=>!/(新聞|電視|電影|如果|假如|朋友|鄰居|聽說)/.test(s));
  const current=clauses.filter(s=>!/(沒有|不再|沒再|不會).{0,3}(痛|失眠|睡不好|頭暈|不舒服|呼吸困難)/.test(s)).join('，');
  let category=categories.find(c=>terms[c].test(current)) || 'none';
  if(terms.safety.test(current)) category='safety';
  if(/沒精神/.test(current) && history.some(x=>terms.sleep.test(x.message))) category='sleep';
  const urgent=/喘不過氣|呼吸困難|胸.{0,4}(劇痛|很痛)|不想活|想自殺|(跌倒|摔倒).{0,10}(起不來|爬不起)/.test(current) && !/(沒有|不會|不想自殺|不是現在)/.test(current);
  let durationDays=0;
  const match=current.match(/(?:連續|已經|持續)?\s*([2-9]|[1-9][0-9])\s*天/);
  if(match) durationDays=Math.min(30,Number(match[1]));
  else if(/一週|一星期/.test(current)) durationDays=7;
  else if(/三天/.test(current)) durationDays=3;
  else if(/好幾天|幾天|兩天/.test(current)) durationDays=2;
  // Improvement must name the condition; an unrelated 「飯煮好了」 cannot close an alert.
  const resolvedCategory=/睡得很好|睡好了|睡眠.{0,4}(改善了|恢復了)/.test(current)?'sleep':/不痛了|沒有不舒服|頭暈好了/.test(clauses.join('，'))?'physical':null;
  if(category==='none' && resolvedCategory) category=resolvedCategory;
  return {category,urgent,durationDays,resolved:Boolean(resolvedCategory && resolvedCategory===category && !urgent),confidence:category==='none'?0:0.8,profileRelevant:false,taskRelevant:false};
}
export function assess({text,history=[],analysis=null,previous=null,now=new Date()}) {
  const base=rules(text,history),ai=analysis && analysis.confidence>=0.8?analysis:null;
  let category=base.category!=='none'?base.category:(ai?.category || 'none');
  if(category==='none') return null;
  const old=previous?.category===category?previous:null;
  if(!base.urgent && (base.resolved || (ai?.resolved && ai.category===category && !ai.urgent))) return old?{...old,status:'resolved',level:'green',category,resolved:true}:null;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const days=[...new Set([...(old?.signal_days||[]),today])].slice(-30);
  const duration=Math.max(base.durationDays,Math.min(30,ai?.durationDays||0));
  const urgent=base.urgent || Boolean(ai?.urgent && ai.confidence>=0.9);
  const relevant=Boolean(ai?.profileRelevant || ai?.taskRelevant);
  const persistent=days.length>=2 && (!old || now-new Date(old.first_seen)>=6*3600000);
  const level=urgent || old?.level==='red'?'red':persistent || duration>=2 || old?.level==='yellow'?'yellow':'green';
  const reason=level==='red'?'urgent':persistent?(relevant?'background':'repeated'):duration>=2?'duration':old?.level==='yellow'?old.reason:'single';
  return {category,level,reason,status:'open',signal_days:days,reported_days:Math.max(duration,old?.reported_days||0),first_seen:old?.first_seen||now,last_seen:now,occurrences:(old?.occurrences||0)+1};
}
export function shouldNotify(event,latestFamilyAlert,pending,now) {
  if(!event || event.level==='green' || event.status!=='open' || pending) return false;
  if(event.level==='red' && event.last_notified_level!=='red') return true;
  if(latestFamilyAlert && now-new Date(latestFamilyAlert)<3600000) return false;
  if(event.last_notified_at && now-new Date(event.last_notified_at)<86400000) return false;
  return !event.last_notified_at || new Date(event.last_seen)>new Date(event.last_notified_at);
}
export function alertText(event) {
  const days=Math.max(1,Math.floor((new Date(event.last_seen)-new Date(event.first_seen))/86400000)+1);
  const duration=event.reported_days>=2?`家人自述至少 ${event.reported_days} 天（待親自確認）`:days===1?'本次對話提及（實際開始時間待確認）':`最近 ${days} 天內持續提及`;
  return `${event.level==='red'?'🔴 請盡快親自確認':'🟡 請近期關心'}\n類型：${labels[event.category]}\n時間：${duration}\n原因：${reasons[event.reason]}。\n建議：請親自聯絡，確認目前情況、持續多久，以及是否需要陪伴或協助。\n這不是醫療診斷或緊急救援通知。`;
}
