import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { managerChildScope, managerCostRollup, managerRollupText, managerTokenRollup, validateManagerRequest } from './manager-logic.mjs'

assert.deepEqual(validateManagerRequest({ id: 'req-1', tool: 'sub_spawn', args: { task: 'slice' } }), { id: 'req-1', tool: 'sub_spawn', args: { task: 'slice' } })
assert.deepEqual(validateManagerRequest({ id: '../bad', tool: 'sub_spawn', args: {} }), { error: 'invalid request id' })
assert.deepEqual(validateManagerRequest({ id: 'r1', tool: 'sub_exec', args: {} }), { error: 'unknown tool' })
assert.deepEqual(validateManagerRequest({ id: 'r1', tool: 'sub_wait', args: [] }), { error: 'args must be an object' })
assert.equal(managerChildScope({ id: 'w3', agent: 'manager' }, { id: 'w7', parent: 'w3' }), undefined)
assert.equal(managerChildScope({ id: 'w3', agent: 'manager' }, { id: 'w7', parent: 'w4' }), 'w7 is not your sub-worker')
assert.equal(managerChildScope({ id: 'w1', agent: 'dev' }, { id: 'w7', parent: 'w1' }), 'w7 is not your sub-worker')
assert.ok(Math.abs(managerCostRollup(0.3, [0.1, 0.2, Number.NaN]) - 0.6) < 1e-12)
assert.equal(managerTokenRollup(12, [3, 4, Number.NaN]), 19)
assert.equal(managerRollupText([{ id: 'w7', title: 'slice', state: 'done', files: ['a.ts'], cost: 0.2, warn: ['check failed'] }]), 'w7 slice — done; files: a.ts; cost $0.200; ⚠ check failed')

const [helper, source] = await Promise.all([
  readFile(new URL('./manager-logic.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../hooks/register.tsx', import.meta.url), 'utf8'),
])
const body = (text, name) => text.match(new RegExp(`(?:export )?function ${name}\\([^)]*\\)(?:\\s*:[^\\n]+)?\\s*(\\{[\\s\\S]*?^\\})`, 'm'))?.[1]
assert.match(source, /parent: w\.parent/)
assert.match(source, /maxSubWorkers: w\.maxSubWorkers/)
const stripTypes = text => text.replaceAll(' as Record<string, unknown>', '').replaceAll(' as unknown', '')
for (const name of ['validateManagerRequest', 'managerChildScope', 'managerCostRollup', 'managerTokenRollup', 'managerRollupText']) {
  assert.ok(body(helper, name), `missing tested helper ${name}`)
  assert.equal(stripTypes(body(source, name)), body(helper, name), `${name} differs from its tested inline implementation`)
}
console.log('PASS manager bridge validation, scope, accounting, rollup, and register parity')
