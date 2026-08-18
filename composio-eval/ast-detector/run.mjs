/** Runs detect.mjs over the fixture corpus and scores it against ground truth. */
import { detect } from './detect.mjs';
import { CASES } from './fixtures/cases.mjs';

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
let pass = 0, hardPass = 0, hardTotal = 0;

console.log(`${'case'.padEnd(26)}${'hard'.padEnd(6)}${'result'.padEnd(9)}detected`);
console.log('-'.repeat(78));

for (const c of CASES) {
  const r = detect(c.code);
  const want = [...c.expect].sort();
  const got = r.tools;
  const ok = eq(want, got);
  if (ok) pass++;
  if (c.hard) { hardTotal++; if (ok) hardPass++; }
  const note = c.unresolvable ? ' (unresolvable by design)'
    : c.toolkitOnly ? ` (toolkit-only: ${r.toolkits.join(',')})` : '';
  console.log(
    `${c.name.padEnd(26)}${(c.hard ? 'yes' : 'no').padEnd(6)}${(ok ? 'PASS' : 'FAIL').padEnd(9)}` +
    `${got.length ? got.join(', ') : '(none)'}${note}`
  );
  if (!ok) console.log(`${' '.repeat(41)}expected: ${want.join(', ') || '(none)'}`);
  for (const u of r.unresolved) {
    console.log(`${' '.repeat(41)}unresolved[${u.kind}] line ${u.line}: ${u.text}`);
  }
}

console.log('-'.repeat(78));
console.log(`overall: ${pass}/${CASES.length}`);
console.log(`call sites BubbleLab's injector refuses (ternary/map/object-literal/nested): ` +
  `${hardPass}/${hardTotal} of the hard cases`);

