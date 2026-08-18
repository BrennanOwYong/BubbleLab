import { detect } from './detect.mjs';
const NEG = [
  { name: 'no-composio-import', code: `
const agent = makeAgent();
await agent.tools.execute('SOME_OTHER_THING', {});
` },
  { name: 'bubblelab-only-flow', code: `
import { SlackBubble } from '@bubblelab/bubble-core';
const slack = new SlackBubble({ operation: 'send_message', channel: '#x' });
await slack.action();
` },
  { name: 'composio-imported-never-used', code: `
import { Composio } from '@composio/core';
const rows = await db.query('select 1');
` },
];
for (const c of NEG) {
  const r = detect(c.code);
  const clean = r.tools.length === 0;
  console.log(`${c.name.padEnd(30)}${clean ? 'PASS (no false positive)' : 'FAIL -> ' + r.tools.join(',')}   usesComposio=${r.usesComposio}`);
}
// strict vs relaxed on the adversarial set
import { ADVERSARIAL } from './fixtures/adversarial.mjs';
console.log('\nstrict vs relaxed on adversarial cases:');
for (const c of ADVERSARIAL) {
  const s = detect(c.code, { relaxed: false }).tools;
  const l = detect(c.code, { relaxed: true }).tools;
  console.log(`  ${c.name.padEnd(26)} strict=[${s.join(',')||'-'}]  relaxed=[${l.join(',')||'-'}]`);
}

