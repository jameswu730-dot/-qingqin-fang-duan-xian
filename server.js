import 'dotenv/config';
import {createPool,migrate,safeLog} from './src/db.js';
import {createApp} from './src/app.js';
import {createWorker} from './src/worker.js';
import {createLine} from './src/line.js';
import {createAI,budgetReservation} from './src/ai.js';

async function startServer() {
  for (const key of ['DATABASE_URL','LINE_CHANNEL_ACCESS_TOKEN','LINE_CHANNEL_SECRET']) {
    if (!process.env[key]) throw new Error('required_environment_missing');
  }
  const pool=createPool();
  pool.on('error',e=>safeLog('database_pool_error',e));
  await migrate(pool);
  const analyze=createAI({reserve:budgetReservation(pool,process.env.OPENAI_DAILY_CALL_LIMIT)});
  const worker=createWorker(pool,{line:createLine(process.env.LINE_CHANNEL_ACCESS_TOKEN),analyze});
  await worker.cleanup();
  const app=createApp({pool,secret:process.env.LINE_CHANNEL_SECRET,wake:()=>void worker.tick()});
  const aiConfigured=Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL && Number(process.env.OPENAI_DAILY_CALL_LIMIT)>0);
  const server=app.listen(process.env.PORT || 3000,'0.0.0.0',()=>console.log(aiConfigured?'v1_server_ready_ai_configured':'v1_server_ready_rules_only'));
  const interval=setInterval(()=>void worker.tick(),2000);
  const retention=setInterval(()=>void worker.cleanup().catch(e=>safeLog('retention_failed',e)),3600000);
  void worker.tick();
  let stopping=false;
  const stop=()=>{
    if(stopping)return;stopping=true;
    clearInterval(interval);clearInterval(retention);
    server.close(()=>{void pool.end().then(()=>process.exit(0));});
    setTimeout(()=>process.exit(1),25000).unref();
  };
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
startServer().catch(e=>{safeLog('startup_failed',e);process.exit(1);});
