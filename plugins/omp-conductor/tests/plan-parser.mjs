export function parsePlan(text, agents) {
  const marker = /(?:^|\n)\s*PLAN\s*:\s*/.exec(text)
  if (!marker) return { error: 'report has no PLAN: JSON block' }
  const start = marker.index + marker[0].length
  if (text[start] !== '[') return { error: 'PLAN must be a JSON array' }
  let depth = 0
  let quoted = false
  let escaped = false
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? ''
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) { end = i; break }
  }
  if (end < 0) return { error: 'PLAN JSON array is incomplete' }
  let plan
  try {
    plan = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    return { error: `invalid PLAN JSON: ${String(err)}` }
  }
  if (!Array.isArray(plan) || !plan.length) return { error: 'PLAN must contain at least one task' }
  const ids = new Set()
  for (const [index, task] of plan.entries()) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return { error: `task ${index + 1} must be an object` }
    if (typeof task.id !== 'string' || !/^[\w.-]+$/.test(task.id) || ids.has(task.id)) return { error: `task ${index + 1} needs a unique id` }
    ids.add(task.id)
    if (typeof task.title !== 'string' || !task.title.trim() || typeof task.task !== 'string' || !task.task.trim()) return { error: `task ${task.id} needs a title and task` }
    if (typeof task.agent !== 'string' || !agents.includes(task.agent)) return { error: `task ${task.id} has unknown agent "${String(task.agent)}"` }
    if (task.owns !== undefined && (!Array.isArray(task.owns) || !task.owns.every(p => typeof p === 'string' && p.trim()))) return { error: `task ${task.id} owns must be non-empty file patterns` }
    if (task.after !== undefined && (!Array.isArray(task.after) || !task.after.every(id => typeof id === 'string'))) return { error: `task ${task.id} after must be an array of task ids` }
    if (task.codex !== undefined && typeof task.codex !== 'boolean') return { error: `task ${task.id} codex must be boolean` }
  }
  for (const task of plan) {
    for (const id of task.after ?? []) if (!ids.has(id)) return { error: `task ${task.id} depends on unknown task ${id}` }
    for (const id of task.after ?? []) if (id === task.id) return { error: `task ${task.id} cannot depend on itself` }
  }
  const patterns = plan.flatMap(task => (task.owns ?? []).map(pattern => ({ id: task.id, pattern })))
  for (let i = 0; i < patterns.length; i++) for (let j = i + 1; j < patterns.length; j++) {
    if (patterns[i].id === patterns[j].id) continue
    const left = patterns[i].pattern.replace(/\\/g, '/').replace(/^\.\//, '')
    const right = patterns[j].pattern.replace(/\\/g, '/').replace(/^\.\//, '')
    const li = left.search(/[*?]/)
    const ri = right.search(/[*?]/)
    const lp = left.slice(0, li < 0 ? left.length : li)
    const rp = right.slice(0, ri < 0 ? right.length : ri)
    if ((!lp || !rp) || (!/[*?]/.test(left) && !/[*?]/.test(right) ? left === right : lp.startsWith(rp) || rp.startsWith(lp))) {
      return { error: `tasks ${patterns[i].id} and ${patterns[j].id} have overlapping owns patterns "${left}" and "${right}"` }
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const visit = id => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    const task = plan.find(item => item.id === id)
    for (const dep of task?.after ?? []) if (!visit(dep)) return false
    visiting.delete(id)
    visited.add(id)
    return true
  }
  for (const task of plan) if (!visit(task.id)) return { error: `PLAN dependency cycle includes ${task.id}` }
  return { plan }
}
