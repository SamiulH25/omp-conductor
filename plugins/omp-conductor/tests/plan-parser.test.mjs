import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parsePlan } from './plan-parser.mjs'

const agents = ['dev', 'explore', 'planner']
const valid = [{ id: 'inspect', title: 'Inspect', agent: 'explore', task: 'Find the API', owns: ['src/api/**'] }, { id: 'implement', title: 'Implement', agent: 'dev', task: 'Build it', owns: ['src/ui/**'], after: ['inspect'], codex: true }]
assert.deepEqual(parsePlan(`Report\nPLAN: ${JSON.stringify(valid)}`, agents).plan, valid)
assert.match(parsePlan('no plan here', agents).error, /no PLAN/)
assert.match(parsePlan('PLAN: [not json]', agents).error, /invalid PLAN JSON/)
assert.match(parsePlan(`PLAN: ${JSON.stringify([{ ...valid[0], agent: 'missing' }])}`, agents).error, /unknown agent/)
assert.match(parsePlan(`PLAN: ${JSON.stringify([valid[0], { ...valid[1], owns: ['src/api/client.ts'] }])}`, agents).error, /overlapping owns/)
assert.match(parsePlan(`PLAN: ${JSON.stringify([{ ...valid[0], after: ['missing'] }])}`, agents).error, /unknown task/)
assert.match(parsePlan(`PLAN: ${JSON.stringify([{ ...valid[0], after: ['next'] }, { ...valid[1], id: 'next', after: ['inspect'] }])}`, agents).error, /cycle/)

const register = await readFile(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const sourceBody = register.match(/^function parsePlan\([^)]*\)(?:\s*:\s*\{[^\n]*\})?\s*(\{[\s\S]*?^\})/m)?.[1]
assert.ok(sourceBody, 'parsePlan is inlined in register.tsx')
const normalized = sourceBody.replaceAll(/<string>/g, '').replaceAll(/: string/g, '').replaceAll(/(\])!/g, '$1').replaceAll('(p: unknown)', 'p').replaceAll('(id: unknown)', 'id').replaceAll('(pattern: string)', 'pattern').replaceAll('(pattern)', 'pattern').replaceAll('const visit = (id) => {', 'const visit = id => {')
const helper = await readFile(new URL('./plan-parser.mjs', import.meta.url), 'utf8')
const helperBody = helper.match(/^export function parsePlan\([^)]*\)\s*(\{[\s\S]*?^\})/m)?.[1]
assert.equal(normalized, helperBody, 'tested parser must match the inlined register implementation')
console.log('PASS plan parser, validator, and register parity')
