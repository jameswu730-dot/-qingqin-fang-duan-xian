import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,message} from './helpers.js';
import {handle} from '../src/care.js';
import {createWorker} from '../src/worker.js';
import {assess} from '../src/radar.js';
import {createPool} from '../src/db.js';

test('failed push preserves cooldown, retry identity, and succeeds after worker recreation',async()=>{
  const db=await database();let now=new Date();const sent=[];
  try {
    await db.query("INSERT INTO family_links(parent_line_user_id,child_line_user_id) VALUES('p','c')");
    await handle(db,message('p','失眠已經三天'),{now});
    // Replies are independent of radar pushes.
    await db.query("UPDATE notification_outbox SET status='cancelled' WHERE kind='reply'");
    let w=createWorker(db,{clock:()=>now,line:async(...args)=>{sent.push(args);throw new Error('test network outage');}});
    assert.equal(await w.sendOne(),true);
    assert.equal((await db.query('SELECT last_notified_at FROM radar_events')).rows[0].last_notified_at,null);
    assert.equal((await db.query("SELECT attempts FROM notification_outbox WHERE kind='push'")).rows[0].attempts,1);
    now=new Date(+now+61000);
    w=createWorker(db,{clock:()=>now,line:async(...args)=>sent.push(args)});
    assert.equal(await w.sendOne(),true);
    assert.equal(sent[0][3],sent[1][3]);
    assert.ok((await db.query('SELECT last_notified_at FROM radar_events')).rows[0].last_notified_at);
    assert.equal(await w.sendOne(),false);
  } finally {await db.end();}
});

test('expired and unauthorized pairing; cross-role users cannot pair twice',async()=>{
  const db=await database();let now=new Date();
  try {
    await handle(db,message('p','建立配對'),{now});
    const code=(await db.query('SELECT code FROM pairing_requests')).rows[0].code;
    assert.match(await handle(db,message('p',`加入配對 ${code}`),{now}),/無效/);
    now=new Date(+now+600001);
    assert.match(await handle(db,message('c',`加入配對 ${code}`),{now}),/無效/);
    await db.query("INSERT INTO family_links(parent_line_user_id,child_line_user_id) VALUES('p','c')");
    assert.match(await handle(db,message('c','建立配對'),{now}),/已有/);
  } finally {await db.end();}
});

test('task scheduling: one question at a time, daily spacing, ownership and expiry',async()=>{
  const db=await database();let now=new Date();let contexts=[];
  try {
    await db.query("INSERT INTO family_links(parent_line_user_id,child_line_user_id) VALUES('p','c'),('other-p','other-c')");
    await handle(db,message('c','本週關心 散步如何'),{now});
    await handle(db,message('c','本週關心 菜園如何'),{now});
    const analyze=async ctx=>{contexts.push(ctx);return {reply:ctx.eligibleTask?'散步時有看到什麼花嗎？':'謝謝你告訴我。',category:'none',confidence:1,askedTaskId:ctx.eligibleTask?.id,answeredTaskId:ctx.askedTasks[0]?.id};};
    await handle(db,message('p','今天去散步'),{now,analyze});
    assert.ok(contexts[0].eligibleTask);
    assert.equal((await db.query("SELECT count(*) AS n FROM care_tasks WHERE status='asked'")).rows[0].n,1);
    await handle(db,message('p','看到好多花'),{now,analyze});
    assert.equal(contexts[1].eligibleTask,null);assert.equal(contexts[1].allowQuestion,false);
    await handle(db,message('p','還看到小狗'),{now,analyze});
    assert.equal(contexts[2].eligibleTask,null);
    assert.match(await handle(db,message('other-c','取消任務 2'),{now}),/找不到/);
    now=new Date(+now+8*86400000);
    await handle(db,message('p','今天散步'),{now,analyze});
    assert.equal(contexts.at(-1).eligibleTask,null);
  } finally {await db.end();}
});

test('midnight alone does not create persistence; red remains high until resolution',()=>{
  const before=assess({text:'睡不好',now:new Date('2026-09-20T15:59:00Z')});
  const after=assess({text:'半夜又醒了',previous:before,now:new Date('2026-09-20T16:01:00Z')});
  assert.equal(after.level,'green');
  const red=assess({text:'胸口劇痛',now:new Date()});
  assert.equal(assess({text:'胸口痛',previous:red,now:new Date()}).level,'red');
});

test('database transport verifies certificate even with sslmode in URL',async()=>{
  const pool=createPool({DATABASE_URL:'postgres://test:test@localhost/test?sslmode=require'});
  assert.equal(pool.options.ssl.rejectUnauthorized,true);
  assert.ok(!pool.options.connectionString.includes('sslmode'));
  await pool.end();
});
