import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildInput,createAI,budgetReservation} from '../src/ai.js';
import {database} from './helpers.js';
const env={OPENAI_API_KEY:'fake-unit-test-key',OPENAI_MODEL:'gpt-4o-mini',OPENAI_DAILY_CALL_LIMIT:'2'};
const context={text:'半夜又醒了',profile:{nickname:'媽媽',avoid_topics:['體重'],lineUserId:'must-not-leave'},history:[{speaker:'parent',message:'昨天睡不好',created_at:'2026-09-20T04:00:00Z',lineUserId:'must-not-leave'}],events:[{category:'sleep',level:'green',first_seen:'2026-09-20',last_seen:'2026-09-20',parent_line_user_id:'must-not-leave'}],allowQuestion:true,eligibleTask:{id:'7',topic:'睡眠如何'},askedTasks:[{id:'6',topic:'最近散步如何'}],LINE_CHANNEL_SECRET:'must-not-leave'};
const good={reply:'半夜又醒來，今天有比較累嗎？',category:'sleep',urgent:false,durationDays:0,resolved:false,confidence:0.95,profileRelevant:true,taskRelevant:true,askedTaskId:'7',answeredTaskId:null};
const response=value=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]})});
test('AI uses bounded allowlisted context, structured output and store:false',async()=>{
  let request;
  const ai=createAI({env,reserve:async()=>true,fetchImpl:async(url,init)=>{request={url,...JSON.parse(init.body)};return response(good);}});
  const result=await ai(context);
  assert.equal(result.category,'sleep');assert.equal(result.askedTaskId,'7');
  assert.equal(request.url,'https://api.openai.com/v1/responses');assert.equal(request.store,false);
  assert.equal(request.text.format.strict,true);assert.equal(request.max_output_tokens,600);
  assert.ok(!request.input.includes('must-not-leave'));assert.ok(request.input.includes('昨天睡不好'));
  const oversized=buildInput({...context,text:'x'.repeat(5000),history:Array.from({length:30},()=>({speaker:'parent',message:'y'.repeat(2000)}))});
  assert.equal(oversized.current.length,1000);assert.equal(oversized.history.length,12);assert.equal(oversized.history[0].message.length,250);
});
test('missing key or zero/unavailable budget makes no external request',async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return response(good);};
  assert.equal(await createAI({env:{...env,OPENAI_API_KEY:''},reserve:async()=>true,fetchImpl})(context),null);
  assert.equal(await createAI({env:{...env,OPENAI_DAILY_CALL_LIMIT:'0'},reserve:async()=>true,fetchImpl})(context),null);
  assert.equal(await createAI({env,reserve:async()=>false,fetchImpl})(context),null);
  assert.equal(calls,0);
});
test('AI rejection, timeout, malformed output and bad enum degrade without leaking errors',async()=>{
  for(const fetchImpl of [async()=>({ok:false,status:401}),async()=>{throw new Error('fake sensitive diagnostic');},async()=>({ok:true,json:async()=>({status:'incomplete'})}),async()=>response({...good,category:'diagnosis'}),async()=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]})})]) {
    assert.equal(await createAI({env,reserve:async()=>true,fetchImpl})(context),null);
  }
});
test('unsafe reply, forbidden question and arbitrary task ID cannot pass unchanged',async()=>{
  for(const reply of ['我是你的女兒，已經叫救護車。','你得了失眠症。','體重多少呢？','多久了？現在怎樣？']) {
    const result=await createAI({env,reserve:async()=>true,fetchImpl:async()=>response({...good,reply})})(context);
    assert.notEqual(result.reply,reply);assert.equal(result.askedTaskId,null);
  }
  const noQuestion=await createAI({env,reserve:async()=>true,fetchImpl:async()=>response(good)})({...context,allowQuestion:false});
  assert.ok(!noQuestion.reply.includes('？'));assert.equal(noQuestion.askedTaskId,null);
  const invalidIds=await createAI({env,reserve:async()=>true,fetchImpl:async()=>response({...good,askedTaskId:'999',answeredTaskId:'999'})})(context);
  assert.equal(invalidIds.askedTaskId,null);assert.equal(invalidIds.answeredTaskId,null);
});
test('global daily budget is persistent, atomic and resets on Taiwan calendar date',async()=>{
  const db=await database();let now=new Date('2026-09-20T12:00:00Z');
  try {
    const reserve=budgetReservation(db,3,()=>now);
    const results=await Promise.all(Array.from({length:10},()=>reserve()));
    assert.equal(results.filter(Boolean).length,3);
    assert.equal(await budgetReservation(db,3,()=>now)(),false);
    now=new Date('2026-09-20T16:01:00Z');
    assert.equal(await reserve(),true);
    assert.equal(await budgetReservation(db,0,()=>now)(),false);
  } finally {await db.end();}
});
