import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {database,message} from './helpers.js';
import {handle} from '../src/care.js';
import {createWorker} from '../src/worker.js';
import {assess,shouldNotify,alertText,rules} from '../src/radar.js';
import {createLine} from '../src/line.js';
import {createApp} from '../src/app.js';
import crypto from 'node:crypto';

test('radar: ordinary, negated, repeated sleep, urgent and cooldown',()=>{
  assert.equal(assess({text:'今天去公園散步很開心'}),null);
  assert.equal(assess({text:'沒有頭暈，也沒有不舒服'}),null);
  assert.equal(assess({text:'新聞說有人胸口很痛'}),null);
  const first=assess({text:'昨天睡不好',now:new Date('2026-09-20T04:00:00Z')});
  assert.equal(first.level,'green');
  const second=assess({text:'半夜又醒了',previous:first,now:new Date('2026-09-21T04:00:00Z')});
  assert.equal(second.level,'yellow');assert.equal(second.category,'sleep');
  const third=assess({text:'今天整個人沒精神',previous:second,now:new Date('2026-09-22T04:00:00Z')});
  assert.equal(third.first_seen,first.first_seen);assert.equal(third.occurrences,3);
  const red=assess({text:'我跌倒了，現在爬不起來'});
  assert.equal(red.level,'red');
  const now=new Date();
  assert.equal(shouldNotify({...second,last_notified_at:now,last_notified_level:'yellow'},now,false,now),false);
  assert.equal(shouldNotify(red,now,false,now),true);
  assert.equal(shouldNotify(red,null,true,now),false);
  assert.ok(!alertText(third).includes('沒精神'));
  assert.equal(rules('已經睡不好三天').durationDays,3);
});

test('radar recovery requires a matching condition and never overrides an urgent signal',()=>{
  const sleep=assess({text:'已經睡不好三天'});
  assert.equal(assess({text:'飯煮好了',previous:sleep}),null);
  assert.equal(assess({text:'朋友睡好了',previous:sleep}),null);
  assert.equal(assess({text:'睡好了',previous:sleep}).resolved,true);
  const danger=assess({text:'睡好了，但現在喘不過氣',previous:sleep});
  assert.equal(danger.level,'red');
  const continued=assess({text:'跌倒了',previous:danger});
  assert.equal(continued.reason,'urgent');
});

test('SQL integration: pairing confirmation, profile/task authorization, continuity, alerts, unlink, re-pair, retention',async()=>{
  const db=await database();
  try {
    // Migration can be applied twice without losing existing data.
    await db.pg.exec(await readFile(new URL('../migrations/001_v1.sql',import.meta.url),'utf8'));
    let now=new Date('2026-09-20T04:00:00Z');
    const send=(u,t,options={})=>handle(db,message(u,t),{now,...options});
    await send('parent-a','建立配對');
    const code=(await db.query('SELECT code FROM pairing_requests')).rows[0].code;
    await send('child-b',`加入配對 ${code}`);
    assert.equal((await db.query('SELECT * FROM family_links')).rows.length,0);
    assert.match(await send('stranger',`確認配對 ${code}`),/找不到/);
    await send('parent-a',`確認配對 ${code}`);
    assert.equal((await db.query('SELECT * FROM family_links')).rows.length,1);
    assert.match(await send('parent-a','設定稱呼 測試'),/子女/);
    assert.match(await send('stranger','查看設定'),/配對/);
    await send('child-b','設定稱呼 媽媽');
    await send('child-b','設定禁問 體重');
    await send('child-b','本週關心 最近散步還順利嗎');
    const contexts=[];
    const analyze=async x=>{contexts.push(x);return null;};
    await send('parent-a','今天買了菜',{analyze});
    assert.equal((await db.query('SELECT * FROM radar_events')).rows.length,0);
    await send('parent-a','昨天睡不好',{analyze});
    assert.equal((await db.query('SELECT level FROM radar_events')).rows[0].level,'green');
    now=new Date(+now+86400000);
    await send('parent-a','半夜又醒了',{analyze});
    assert.equal((await db.query('SELECT level FROM radar_events')).rows[0].level,'yellow');
    const alerts=await db.query('SELECT * FROM notification_outbox WHERE radar_id IS NOT NULL');
    assert.equal(alerts.rows.length,1);assert.ok(!alerts.rows[0].content.includes('半夜又醒了'));
    assert.ok(contexts.at(-1).history.some(x=>x.message==='昨天睡不好'));
    assert.equal(contexts.at(-1).profile.nickname,'媽媽');
    assert.equal(contexts.at(-1).allowQuestion,false);
    const deliveries=[];
    const worker=createWorker(db,{line:async(...x)=>deliveries.push(x),clock:()=>now});
    while(await worker.sendOne()) {}
    assert.ok(deliveries.some(x=>x[0]==='push' && x[2].includes('請近期關心')));
    await send('parent-a','仍然睡不好',{analyze});
    assert.equal((await db.query('SELECT * FROM notification_outbox WHERE radar_id IS NOT NULL')).rows.length,1);
    await send('parent-a','我現在喘不過氣',{analyze});
    assert.equal((await db.query("SELECT * FROM radar_events WHERE level='red'")).rows.length,1);
    await send('child-b','解除綁定');
    assert.ok((await db.query('SELECT revoked_at FROM family_links')).rows[0].revoked_at);
    assert.equal((await db.query("SELECT * FROM notification_outbox WHERE radar_id IS NOT NULL AND status='pending'")).rows.length,0);
    while(await worker.sendOne()) {}
    assert.ok(deliveries.some(x=>x[1]==='parent-a' && x[2].includes('解除')));
    const count=deliveries.filter(x=>x[2].includes('請盡快')).length;
    await send('parent-a','我現在喘不過氣');
    while(await worker.sendOne()) {}
    assert.equal(deliveries.filter(x=>x[2].includes('請盡快')).length,count);
    await send('parent-a','建立配對');
    const code2=(await db.query('SELECT code FROM pairing_requests')).rows[0].code;
    await send('child-b',`加入配對 ${code2}`);await send('parent-a',`確認配對 ${code2}`);
    assert.equal((await db.query('SELECT * FROM family_links WHERE revoked_at IS NULL')).rows.length,1);
    now=new Date(+now+31*86400000);await worker.cleanup();
    assert.equal((await db.query('SELECT * FROM messages')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM family_links')).rows.length,1);
  } finally {await db.end();}
});

test('database reopen retains family, conversation, cooldown and inbox idempotency',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qingqin-test-'));
  let db=await database(dir);
  await db.query("INSERT INTO family_links(parent_line_user_id,child_line_user_id) VALUES('p','c')");
  const now=new Date();
  await handle(db,message('p','已經失眠三天','event-one'),{now});
  const w=createWorker(db,{line:async()=>{},clock:()=>now});
  while(await w.sendOne()) {}
  await db.end();
  db=await database(dir);
  try {
    let context;
    await handle(db,message('p','今天還是沒精神'),{now:new Date(+now+3600000),analyze:async x=>{context=x;return null;}});
    assert.ok(context.history.some(x=>x.message==='已經失眠三天'));
    assert.equal((await db.query('SELECT * FROM notification_outbox WHERE radar_id IS NOT NULL')).rows.length,1);
  } finally {await db.end();}
});

test('LINE retries reuse retry key; 409 is success only with accepted request ID',async()=>{
  const calls=[];
  const line=createLine('fake-test-token',async(url,init)=>{calls.push(init);return {ok:false,status:409,headers:new Headers({'x-line-accepted-request-id':'accepted'})};});
  await line('push','test-child','摘要','fixed-uuid');
  await line('push','test-child','摘要','fixed-uuid');
  assert.equal(calls[0].headers['X-Line-Retry-Key'],calls[1].headers['X-Line-Retry-Key']);
  await assert.rejects(createLine('test',async()=>({ok:false,status:409,headers:new Headers()}))('push','c','摘要','key'));
});

test('signed HTTP webhook persists before ack, deduplicates and denies ID lookup',async()=>{
  const db=await database();const secret='local-test-only';
  const app=createApp({pool:db,secret});const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.on('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    const body=JSON.stringify({events:[message('p','建立配對','duplicate-id')]});
    const sig=crypto.createHmac('sha256',secret).update(body).digest('base64');
    const request=s=>fetch(`${url}/webhook`,{method:'POST',headers:{'Content-Type':'application/json','x-line-signature':s},body});
    assert.equal((await request('bad')).status,401);
    assert.equal((await request(sig)).status,200);assert.equal((await request(sig)).status,200);
    assert.equal((await db.query('SELECT * FROM webhook_inbox')).rows.length,1);
    assert.equal((await fetch(`${url}/api/family/p`)).status,403);
    const worker=createWorker(db,{line:async()=>{}});await worker.processOne();
    const inbox=(await db.query('SELECT * FROM webhook_inbox')).rows[0];
    assert.equal(inbox.status,'done');assert.equal(inbox.payload,null);assert.equal(inbox.source_id,null);
    assert.equal(await worker.processOne(),false);
  } finally {await new Promise(resolve=>server.close(resolve));await db.end();}
});
