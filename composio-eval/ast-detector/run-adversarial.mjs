import { detect } from './detect.mjs';
import { ADVERSARIAL } from './fixtures/adversarial.mjs';
const eq=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
let pass=0;
for (const c of ADVERSARIAL) {
  const r=detect(c.code); const want=[...c.expect].sort(); const ok=eq(want,r.tools);
  if(ok)pass++;
  console.log(`${c.name.padEnd(26)}${ok?'PASS':'FAIL'}  detected: ${r.tools.join(', ')||'(none)'}`);
  if(!ok) console.log(`${' '.repeat(28)}expected: ${want.join(', ')||'(none)'}   <- ${c.why}`);
  r.unresolved.forEach(u=>console.log(`${' '.repeat(28)}unresolved[${u.kind}]: ${u.text}`));
}
console.log(`\nadversarial: ${pass}/${ADVERSARIAL.length}`);

