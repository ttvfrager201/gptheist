import { constants } from 'node:fs';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureSafeAuditDirectory } from './simulation.js';
import type { PaperMarketFrame } from './paper-laboratory.js';
/** Optional research tape. Critical account/trades remain in PaperStore and are never pruned here. */
export class ForwardRecorder {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private written = 0;
  private skipped = 0;
  private error: string | null = null;
  constructor(private readonly directory: string, private readonly maxBytes = 128*1048576, private readonly retentionMs = 86_400_000) {}
  status() { return { written:this.written, skipped:this.skipped, pending:this.pending, error:this.error, maxBytes:this.maxBytes,retentionMs:this.retentionMs }; }
  record(frame: PaperMarketFrame): Promise<void> {
    if(this.pending>=2) { this.skipped++;return Promise.resolve(); }
    this.pending++;
    const work=this.tail.then(async()=>{
      const root=await ensureSafeAuditDirectory(this.directory),now=Date.parse(frame.completedAt);
      const names=(await readdir(root)).filter(n=>/^research-\d{13}\.jsonl$/.test(n)).sort();
      let total=0;const files=[];
      for(const name of names){const info=await stat(resolve(root,name));files.push({name,size:info.size});total+=info.size;}
      const text=JSON.stringify({...frame,recordingSkippedFrames:this.skipped})+'\n',bytes=Buffer.byteLength(text);
      if(bytes>Math.min(2*1048576,this.maxBytes)) {this.skipped++;return;}
      for(const file of files) if(now-Number(file.name.slice(9,22))>this.retentionMs || total+bytes>this.maxBytes) {
        await unlink(resolve(root,file.name));total-=file.size;
      }
      const name=`research-${String(Math.floor(now/3_600_000)*3_600_000).padStart(13,'0')}.jsonl`;
      const h=await open(resolve(root,name),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
      try{await h.writeFile(text);}finally{await h.close();}
      this.written++;this.error=null;
    }).catch(error=>{this.skipped++;this.error=error instanceof Error?error.message.slice(0,200):'Research recording failed';}).finally(()=>{this.pending--;});
    this.tail=work;return work;
  }
  async close() { await this.tail; }
}
