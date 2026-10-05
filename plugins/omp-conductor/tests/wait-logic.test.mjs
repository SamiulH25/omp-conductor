import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const firstWaitChanged = (state, wasQueued, warningCount, previousWarningCount, reviewPending = false) =>
  (wasQueued && state === 'running') || (state !== 'running' && state !== 'queued' && !reviewPending) || warningCount > previousWarningCount

assert.equal(firstWaitChanged('running', false, 0, 0), false)
assert.equal(firstWaitChanged('queued', true, 0, 0), false)
assert.equal(firstWaitChanged('running', true, 0, 0), true)
assert.equal(firstWaitChanged('running', false, 1, 0), true)
assert.equal(firstWaitChanged('done', false, 0, 0, true), false)
assert.equal(firstWaitChanged('done', false, 1, 0, true), true)
assert.equal(firstWaitChanged('queued', true, 1, 0), true)
for (const state of ['done', 'failed', 'killed']) assert.equal(firstWaitChanged(state, false, 0, 0), true)

const source = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const expression = source.match(/const firstWaitChanged = \(state: State, wasQueued: boolean, warningCount: number, previousWarningCount: number, reviewPending = false\) =>\n  ([^\n]+)/)?.[1]
assert.equal(expression, '(wasQueued && state === \'running\') || (state !== \'running\' && state !== \'queued\' && !reviewPending) || warningCount > previousWarningCount')

console.log('pi_wait event logic tests passed')
