import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { agyEventsToPi, agyToolArgs, agyToolName } from './agy-logic.mjs'

assert.equal(agyToolName('run_command'), 'bash')
assert.equal(agyToolName('write_to_file'), 'edit')
assert.equal(agyToolName('view_file'), 'read')
assert.equal(agyToolName('search_web'), 'search_web')
assert.deepEqual(agyToolArgs({ CommandLine: 'ls' }), { CommandLine: 'ls', command: 'ls' })
assert.equal(agyToolArgs({ TargetFile: '/a/b.txt' }).path, '/a/b.txt')

// A recorded run: init, a tool call, a text turn, a result.
const st = { turns: {} }
const feed = ev => agyEventsToPi(ev, st)
assert.deepEqual(feed({ event: 'init', conversation_id: 'c1', init: { model: 'm' } }), [{ type: 'response', command: 'get_state', success: true, data: { sessionId: 'c1' } }])
const start = feed({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: '/w/x.txt' } } } })
assert.equal(start[0].type, 'tool_execution_start')
assert.equal(start[0].toolName, 'edit')
assert.equal(start[0].args.path, '/w/x.txt')
const end = feed({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' }, output: 'x.txt\n' } } })
assert.equal(end[0].type, 'tool_execution_end')
assert.equal(end[0].isError, false)
assert.equal(end[0].result.content[0].text, 'x.txt\n')
const turn = [
  ...feed({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'done' } }),
  ...feed({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 5 } } }),
]
assert.deepEqual(turn.map(e => e.type), ['turn_start', 'message_update', 'message_update', 'message_update', 'turn_end'])
assert.equal(turn[3].assistantMessageEvent.content, 'done')
assert.equal(turn[4].message.usage.cacheRead, 5)
assert.deepEqual(feed({ event: 'result', result: { status: 'SUCCESS', response: 'done\n' } }), [{ type: 'agent_settled' }])
assert.deepEqual(feed({ event: 'result', result: { status: 'ERROR', error: 'boom' } }).map(e => e.type), ['message_end', 'agent_settled'])
assert.deepEqual(feed({ event: 'other' }), [])

const functionBody = (source, name) => source.match(new RegExp(`^(?:export )?function ${name}\\([^)]*\\)\\s*(\\{[\\s\\S]*?^\\})`, 'm'))?.[1]
const [helperSource, registerSource] = await Promise.all([
  readFile(new URL('./agy-logic.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../hooks/register.tsx', import.meta.url), 'utf8'),
])
for (const name of ['agyToolName', 'agyToolArgs', 'agyEventsToPi']) {
  assert.ok(functionBody(helperSource, name), `${name} exists in the test helper`)
  assert.equal(functionBody(registerSource, name), functionBody(helperSource, name), `inlined ${name} body must match the tested helper`)
}
console.log('PASS agy event translation and register parity')
