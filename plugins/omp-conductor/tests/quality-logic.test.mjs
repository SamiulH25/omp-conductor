import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseReviewFindings, rankBestOfN } from './quality-logic.mjs'

const findings = parseReviewFindings(`No blocking issues in the overview.\n\n- [high] src/auth.ts:41:2 — Missing authorization allows any signed-in user to delete another user's record.\n\n- Severity: medium\n  src/ui.tsx:8 — The empty state text is unclear.`)
assert.equal(findings.length, 2)
assert.equal(findings[0].blocking, true)
assert.equal(findings[0].location, 'src/auth.ts:41:2')
assert.equal(findings[1].blocking, false)
assert.deepEqual(parseReviewFindings('No actionable findings. The code looks correct.'), [])

const ranked = rankBestOfN([
  { id: 'w1', passed: false, warnings: 0, diffSize: 1 },
  { id: 'w2', passed: true, warnings: 2, diffSize: 500 },
  { id: 'w3', passed: true, warnings: 1, diffSize: 20 },
  { id: 'w4', passed: true, warnings: 1, diffSize: 8 },
])
assert.deepEqual(ranked.map(result => result.id), ['w4', 'w3', 'w2', 'w1'])

const [helper, source] = await Promise.all([
  readFile(new URL('./quality-logic.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../hooks/register.tsx', import.meta.url), 'utf8'),
])
const body = (text, name) => text.match(new RegExp(`(?:export )?function ${name}\\([^)]*\\)\\s*(\\{[\\s\\S]*?^\\})`, 'm'))?.[1]
for (const name of ['parseReviewFindings', 'rankBestOfN']) {
  assert.ok(body(helper, name), `missing tested helper ${name}`)
  assert.equal(body(source, name), body(helper, name), `${name} differs from its tested inline implementation`)
}
console.log('PASS quality ranking, review parsing, and register parity')
