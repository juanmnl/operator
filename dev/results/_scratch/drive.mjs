import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
import { chromium } from 'playwright'
const dir=path.resolve('dev/results/_scratch')
const srv=http.createServer((q,r)=>{const f=path.join(dir,q.url.split('?')[0]);try{r.end(fs.readFileSync(f))}catch{r.statusCode=404;r.end()}}).listen(0)
const port=srv.address().port
const [file,cols,chunk,marksJson]=[process.argv[2],+process.argv[3],+process.argv[4],process.argv[5]||'[]']
const b=await chromium.launch(); const p=await b.newPage({deviceScaleFactor:2})
p.on('pageerror',e=>console.error('page',e))
await p.goto(`http://localhost:${port}/page.html`); await p.waitForFunction('window.__ready')
const res=await p.evaluate(([f,c,ch,m])=>window.run('/'+f,c,30,ch,m),[file,cols,chunk,JSON.parse(marksJson)])
console.log(file,'cols',cols,'chunk',chunk,'frames',res.length,'mismatch(not in sync mode):',res.filter(r=>r.mism.length&&!r.sync).length,'mismatch(in sync mode):',res.filter(r=>r.mism.length&&r.sync).length)
for(const r of res.filter(r=>r.mism.length&&!r.sync).slice(0,4)) console.log(JSON.stringify(r))
await p.locator('#term').screenshot({path:path.join(dir,'final-'+file+'.png')})
await b.close(); srv.close()
