import { it } from 'vitest'
import fs from 'node:fs'
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { stripOrnaments } from '../../../src/renderer/lib/terminal'
const S='/private/tmp/claude-501/-Users-juanmnl-Developer-operator/35f9f59f-40fc-4e22-87c2-e0dd4c86edc2/scratchpad/'
const END='\x1b[?2026l'
async function run(file:string, cols:number, rows:number){
  const term=new Terminal({cols,rows,scrollback:10000,allowProposedApi:true})
  term.loadAddon(new UnicodeGraphemesAddon()); term.unicode.activeVersion='15-graphemes'
  const txt=stripOrnaments(new TextDecoder().decode(fs.readFileSync(S+file)))
  const parts=txt.split(END); let bad=0, frames=0, ex:string[]=[]
  for(let k=0;k<parts.length;k++){
    await new Promise<void>(r=>term.write(parts[k]+(k<parts.length-1?END:''),()=>r()))
    const b=term.buffer.active; const lines:string[]=[]
    for(let y=0;y<rows;y++)lines.push(b.getLine(b.viewportY+y)?.translateToString(true)??'')
    const p=lines.map(l=>l.startsWith('❯')).lastIndexOf(true)
    if(p<0)continue
    frames++; if(k%9==5||k==parts.length-2) console.log('FRAME',k,JSON.stringify(lines.slice(p-6,p+4).map(x=>x.replace(/─{8,}/,'<RULE>').slice(0,90))))
    const isRule=(l:string)=>/^─{10,}$/.test(l.trim())
    if(!isRule(lines[p-1]||'')||!isRule(lines[p+1]||'')){bad++; if(!ex.length)ex=lines.slice(Math.max(0,p-4),p+4)}
  }
  console.log(JSON.stringify(Array.from({length:rows},(_,y)=>term.buffer.active.getLine(term.buffer.active.viewportY+y)?.translateToString(true)).slice(-14)));console.log(file,cols+'x'+rows,'frames with ❯:',frames,'frame-ends missing a rule:',bad,JSON.stringify(ex))
}
it('replay',async()=>{ await run(process.env.F||'c120.bin', Number(process.env.C||120), 30) },120000)
