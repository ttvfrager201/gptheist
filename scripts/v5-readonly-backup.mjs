// Can be piped to Node in the EXISTING Railway container. No repo imports or writes.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {once} from 'node:events';
const directory=process.env.PAPER_DATA_DIR??resolve(process.cwd(),'runs/paper');
async function read(name){const h=await open(resolve(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!(await h.stat()).isFile())throw Error('Not regular file');return JSON.parse(await h.readFile('utf8'));}finally{await h.close();}}
async function emit(name,data){if(!process.stdout.write(JSON.stringify({name,data})+'\n'))await once(process.stdout,'drain');}
const state=await read('state.json');if(state.mode!=='PAPER'||![1,2].includes(state.schemaVersion))throw Error('Not a paper account');
await emit('state.json',state);let cursor=state.archiveHead;const seen=new Set();
while(cursor){if(!/^audit-archive-\d+-[0-9a-f-]+\.json$/.test(cursor)||seen.has(cursor))throw Error('Invalid archive chain');seen.add(cursor);const record=await read(cursor);await emit(cursor,record);cursor=record.previous;}
