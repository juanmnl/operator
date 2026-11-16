import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { buildTerminalOptions } from '../../../src/renderer/lib/terminal-options'
import { stripOrnaments } from '../../../src/renderer/lib/terminal'
const theme = { background: '#1e1f24', foreground: '#d7d7d7' }
const END='\x1b[?2026l'
const w:any=window
w.run = async (url:string, cols:number, rows:number, chunk:number, resizeMarks:[number,number][]) => {
  const term=new Terminal({...buildTerminalOptions(theme), cols, rows})
  term.loadAddon(new UnicodeGraphemesAddon()); term.unicode.activeVersion='15-graphemes'
  term.open(document.getElementById('term')!)
  const buf=new Uint8Array(await (await fetch(url)).arrayBuffer()); const dec=new TextDecoder()
  const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
  const raf=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
  // production cadence mirror
  let last=0, t:number=0
  const sched=()=>{const n=Date.now(); if(n-last>180){last=n;term.refresh(0,term.rows-1)}; clearTimeout(t); t=window.setTimeout(()=>{last=Date.now();term.refresh(0,term.rows-1)},90)}
  const check=(tag:string)=>{
    const b=term.buffer.active; const rowEls=Array.from(document.querySelectorAll('.xterm-rows > *')) as HTMLElement[]
    const out:any[]=[]
    for(let i=0;i<term.rows;i++){const bt=(b.getLine(b.viewportY+i)?.translateToString(true)??'').replace(/\u00a0/g,' ').replace(/\s+$/,''); const dt=(rowEls[i]?.textContent??'').replace(/ /g,' ').replace(/\s+$/,''); if(bt!==dt) out.push({row:i,buf:bt,dom:dt})}
    return {tag,sync:(term.modes as any).synchronizedOutputMode,mism:out}
  }
  const results:any[]=[]; let pos=0
  const marks=[...resizeMarks].sort((a,b)=>a[0]-b[0])
  while(pos<buf.length){
    let end=Math.min(pos+chunk,buf.length)
    if(marks.length&&marks[0][0]<=end&&marks[0][0]>pos) end=marks[0][0]
    const s=stripOrnaments(dec.decode(buf.subarray(pos,end),{stream:true}))
    await new Promise<void>(r=>term.write(s,()=>r())); sched(); pos=end
    if(marks.length&&marks[0][0]===pos){ term.resize(marks[0][1],rows); marks.shift() }
    await sleep(16)
    if(s.includes(END)){ await raf(); const c=check('@'+pos); results.push(c) }
  }
  await sleep(400); await raf()
  results.push(check('FINAL'))
  w.__term=term
  return results
}
w.__ready=true
