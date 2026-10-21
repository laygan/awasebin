import {config} from './config.mjs';
import {database} from './db.mjs';
import {createApp} from './app.mjs';
import {processUploads} from './uploads.mjs';
const c=config(),db=database(c.databaseURL),app=await createApp(db,c);
let busy=false;
const timer=setInterval(async()=>{if(busy)return;busy=true;try{await processUploads(db,c);}catch{console.error('Upload worker failed; check database and storage');}finally{busy=false;}},2000);
await app.listen({host:c.host,port:c.port}); console.log(`API listening on ${c.host}:${c.port}`);
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,async()=>{clearInterval(timer);await app.close();while(busy)await new Promise(r=>setTimeout(r,100));await db.close();process.exit(0);});
