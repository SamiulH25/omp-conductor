import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { detectStuck } from './stuck-logic.mjs'

assert.deepEqual(detectStuck([], 4 * 60_000).map(x => x.key), ['idle'])
assert.deepEqual(detectStuck([], 239_999), [])

const repeated = Array.from({ length: 5 }, () => ({ kind: 'tool', tool: 'bash', args: { command: 'npm test' } }))
const loop = detectStuck(repeated, 0)
assert.equal(loop.length, 1)
assert.match(loop[0].message, /looping: bash "npm test" x5/)
assert.deepEqual(detectStuck(repeated.slice(0, 3), 0), [])

const errors = ['bad config', 'bad config', 'bad config'].map(text => ({ kind: 'error', text }))
assert.match(detectStuck(errors, 0)[0].message, /looping: error "bad config" x3/)
assert.deepEqual(detectStuck([...repeated.slice(0, 3), ...errors.slice(0, 2)], 0), [])

const functionBody = source => source.match(/^(?:export )?function detectStuck\([^)]*\)\s*(\{[\s\S]*?^\})/m)?.[1]
const [helperSource, registerSource] = await Promise.all([
  readFile(new URL('./stuck-logic.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../hooks/register.tsx', import.meta.url), 'utf8'),
])
assert.ok(functionBody(helperSource), 'detector function exists in test helper')
assert.equal(functionBody(registerSource), functionBody(helperSource), 'inlined detector body must match tested helper')
console.log('PASS stuck-logic and register parity')
