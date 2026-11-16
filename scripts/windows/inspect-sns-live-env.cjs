'use strict';
const fs=require('node:fs'), util=require('node:util');
if(typeof util.parseEnv!=='function') process.exit(2);
const e=util.parseEnv(fs.readFileSync(process.argv[2],'utf8'));
const keys=['RUN_CRON','TEMPORAL_ADDRESS','TEMPORAL_NAMESPACE','SNS_HELD_IDS_FILE','SNS_STUDIO_READ_ONLY'];
console.log(JSON.stringify(Object.fromEntries(keys.map(k=>[k,e[k]??null]))));