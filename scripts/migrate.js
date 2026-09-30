import 'dotenv/config';
import {createPool,migrate,safeLog} from '../src/db.js';
const pool=createPool();
try {await migrate(pool);console.log('migration_complete');}
catch(e){safeLog('migration_failed',e);process.exitCode=1;}
finally{await pool.end();}
