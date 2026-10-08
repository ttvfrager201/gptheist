// Restore a verified authenticated JSONL export to a NEW offline directory only.
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {mkdir,open,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {validatePaperState} from '../dist/src/paper-store.js';
const [input,target]=process.argv.slice(2);if(!input||!target)throw Error('Usage: node scripts/v5-restore-export.mjs backup.ndjson NEW_DIRECTORY');
const root=resolve(target);await mkdir(root,{mode:0o700});let state,count=0;const hashes={};
for await(const line of createInterface({input:createReadStream(input),crlfDelay:Infinity})){
 const record=JSON.parse(line);if(record.name!=='state.json'&&!/^audit-archive-\d+-[0-9a-f-]+\.json$/.test(record.name))throw Error('Invalid export filename');
 if(hashes[record.name])throw Error('Duplicate export record');
 const text=JSON.stringify(record.data),file=await open(join(root,record.name),'wx',0o600);
 try{await file.writeFile(text);await file.sync();}finally{await file.close();}
 hashes[record.name]=createHash('sha256').update(text).digest('hex');if(record.name==='state.json')state=record.data;count++;
}
validatePaperState(state);const seen=new Set();let cursor=state.archiveHead;
while(cursor){if(seen.has(cursor)||!hashes[cursor])throw Error('Missing or cyclic archive chain');seen.add(cursor);const record=JSON.parse(await readFile(join(root,cursor),'utf8'));cursor=record.previous;}
const file=await open(join(root,'backup-manifest.json'),'wx',0o600);try{await file.writeFile(JSON.stringify({count,hashes},null,2));await file.sync();}finally{await file.close();}
console.log(`Validated ${count} records in offline restore directory; no account started.`);
