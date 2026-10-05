// Shared ownership glob helpers for the spawn guard and the worker edit guard.
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '')

export function matchesGlob(pattern: string, path: string): boolean {
  const glob = normalize(pattern)
  const file = normalize(path)
  let source = '^'
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        source += '(?:.*/)?'
      } else source += '.*'
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`).test(file)
}

export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some(pattern => matchesGlob(pattern, path))
}

// Prefix intersection is intentionally conservative: once either pattern has a wildcard,
// compatible literal prefixes may overlap even when their suffixes are not identical.
export function patternsOverlap(a: string, b: string): boolean {
  const left = normalize(a)
  const right = normalize(b)
  const leftWildcard = /[*?]/.test(left)
  const rightWildcard = /[*?]/.test(right)
  if (!leftWildcard && !rightWildcard) return left === right
  const prefix = (pattern: string) => pattern.slice(0, pattern.search(/[*?]/) < 0 ? pattern.length : pattern.search(/[*?]/))
  const lp = prefix(left)
  const rp = prefix(right)
  if (!lp || !rp) return true
  return lp.startsWith(rp) || rp.startsWith(lp)
}
