import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { matchesAny, matchesGlob, patternsOverlap } from '../extensions/owns.ts'

assert.equal(matchesGlob('src/net/**', 'src/net/client.ts'), true)
assert.equal(matchesGlob('src/**/client?.ts', 'src/client1.ts'), true)
assert.equal(matchesGlob('src/**/client?.ts', 'src/net/client1.ts'), true)
assert.equal(matchesGlob('docs/*.md', 'docs/readme.md'), true)
assert.equal(matchesGlob('docs/*.md', 'docs/nested/readme.md'), false)
assert.equal(matchesGlob('src/net/file.ts', 'src/net/file.ts'), true)
assert.equal(matchesGlob('src/net/file.ts', 'src/net/other.ts'), false)
assert.equal(matchesGlob('src/net/a?.ts', 'src/net/ab.ts'), true)
assert.equal(matchesGlob('src/net/a?.ts', 'src/net/a/b.ts'), false)
assert.equal(matchesAny(['src/**', 'docs/*.md'], 'docs/guide.md'), true)
assert.equal(matchesAny(['src/**', 'docs/*.md'], 'README.md'), false)

assert.equal(patternsOverlap('src/**', 'src/net/**'), true)
assert.equal(patternsOverlap('src/net/*.ts', 'src/net/client.ts'), true)
assert.equal(patternsOverlap('src/net/**', 'src/ui/**'), false)
assert.equal(patternsOverlap('src/net/client.ts', 'src/net/server.ts'), false)
assert.equal(patternsOverlap('**/config.json', 'private/secrets/**'), true) // unknown prefix: be conservative

const registerSource = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
const ownsSource = readFileSync(new URL('../extensions/owns.ts', import.meta.url), 'utf8')
const declaration = (source, name) => {
  const match = source.match(new RegExp(`(?:export\\s+)?function ${name}\\([^]*?\\n\\}`))
  assert.ok(match, `missing ${name} declaration`)
  return match[0].replace(/^export /, '')
}
for (const name of ['matchesGlob', 'matchesAny', 'patternsOverlap']) {
  assert.equal(declaration(registerSource, name), declaration(ownsSource, name), `${name} differs between register.tsx and owns.ts`)
}

console.log('owns matcher tests passed')
