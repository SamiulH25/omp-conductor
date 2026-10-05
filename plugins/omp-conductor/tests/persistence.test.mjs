import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const registerSource = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const declaration = name => {
  const match = registerSource.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))
  assert.ok(match, `missing ${name} declaration`)
  return match[0].replace(/: (?:any|string|boolean|unknown|number)/g, '')
}
const serializeWorkerRecord = new Function(`${declaration('serializeWorkerRecord')}; return serializeWorkerRecord`)()
const restoreWorkerRecord = new Function(`${declaration('restoreWorkerRecord')}; return restoreWorkerRecord`)()

const source = {
  id: 'w12',
  title: 'registry test',
  task: 't'.repeat(600),
  dir: '/repo',
  root: '/repo',
  isGit: true,
  agent: 'dev',
  state: 'done',
  sessionId: 'claude-session',
  pathKey: 'w12',
  startedAt: 10,
  endedAt: 20,
  files: new Set(['src/a.ts']),
  reads: new Set(['README.md']),
  commands: ['npm test'],
  errors: ['e'.repeat(1100)],
  events: Array.from({ length: 305 }, (_, i) => `${i}:${'x'.repeat(220)}`),
  texts: ['f'.repeat(5001)],
  summary: 'summary',
  warn: ['warning'],
  checks: ['typecheck'],
  verify: 'npm test',
  verifyTimeout: 30,
  fixesLeft: 2,
  maxMinutes: 12,
  maxCost: 2,
  budgetWarned: true,
  sessionBudgetWarned: false,
  cost: 1.25,
  tokensIn: 100,
  tokensOut: 50,
  tokensCache: 25,
}
const saved = serializeWorkerRecord(source, 'fallback-session', false)
assert.equal(saved.sessionId, 'claude-session')
assert.equal(saved.pathKey, 'w12')
assert.equal(saved.files[0], 'src/a.ts')
assert.equal(saved.verifyTimeout, 30)
assert.equal(saved.fixesLeft, 2)
assert.equal(saved.maxCost, 2)
assert.equal(saved.budgetWarned, true)
assert.equal(saved.task.length, 500)
assert.equal(saved.finalText.length, 4000)
assert.equal(saved.errors[0].length, 1000)
assert.equal(saved.events.length, 300)
assert.equal(saved.events[0].length, 200)

const running = restoreWorkerRecord({ ...saved, state: 'running', endedAt: undefined, sessionId: 'old-session' }, 'current-session', 1234)
assert.equal(running.state, 'killed')
assert.equal(running.last, 'restored; process stopped, session saved')
assert.equal(running.endedAt, 1234)
assert.equal(running.pathKey, 'w12')
assert.equal(running.sessionId, 'old-session')
assert.equal(running.files.has('src/a.ts'), true)
assert.equal(running.restored, true)

const queued = restoreWorkerRecord({ ...saved, id: 'w13', state: 'queued', endedAt: undefined, pathKey: undefined, sessionId: undefined }, 'legacy-session', 2345)
assert.equal(queued.state, 'killed')
assert.equal(queued.interruptedQueued, true)
assert.equal(queued.pathKey, 'legacy-session-w13')
assert.equal(queued.endedAt, 2345)

const detailed = serializeWorkerRecord({ ...source, state: 'queued', texts: ['d'.repeat(210000)] }, 's', true)
assert.equal(detailed.task.length, 600)
assert.equal(detailed.finalText.length, 200000)

console.log('PASS persistence serialize/restore logic')
