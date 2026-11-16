import { it } from 'vitest'
import fs from 'node:fs'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
const S='/private/tmp/claude-501/-Users-juanmnl-Developer-operator/35f9f59f-40fc-4e22-87c2-e0dd4c86edc2/scratchpad/'
const END='\x1b[?2026l'
const MARKS:[number,number][]=[[2730,70],[4363,120],[6332,45],[7671,120],[9640,90]]
it('resize',async()=>{
  const rows=30; const term=new Terminal({cols:120,rows,scrollback:10000,allowProposedApi:true})
  term.loadAddon(new UnicodeGraphemesAddon()); term.unicode.activeVersion='15-graphemes'
  const buf=fs.readFileSync(S+'cr.bin'); const dec=new TextDecoder()
  const cuts=[0,...MARKS.map(m=>m[0]),buf.length]
  const snap=()=>{const b=term.buffer.active;return Array.from({length:rows},(_,y)=>b.getLine(b.viewportY+y)?.translateToString(true)??'')}
  const report=(tag:string)=>{const l=snap();const p=l.map(x=>x.startsWith('❯')).lastIndexOf(true);const ok=(x?:string)=>/^─{10,}$/.test((x||'').trim());console.log(tag,'cols',term.cols,'prompt@',p,'ruleAbove',p>0&&ok(l[p-1]),'ruleBelow',p>=0&&ok(l[p+1]))
    if(p<0||!ok(l[p-1])||!ok(l[p+1])) console.log(JSON.stringify(l.slice(Math.max(0,p-4),p+3)))}
  for(let s=0;s<cuts.length-1;s++){
    const seg=dec.decode(buf.subarray(cuts[s],cuts[s+1]),{stream:true})
    // write frame by frame
    const parts=seg.split(END)
    for(let k=0;k<parts.length;k++){ await new Promise<void>(r=>term.write(parts[k]+(k<parts.length-1?END:''),()=>r())); if(k<parts.length-1) report(`seg${s} frame${k}`) }
    if(s<MARKS.length){ term.resize(MARKS[s][1],rows); report(`-- xterm resized to ${MARKS[s][1]} (before Claude reacts)`) }
  }
  report('FINAL')
},60000)
