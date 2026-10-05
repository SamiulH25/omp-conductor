export function validateManagerRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'invalid request' }
  const request = value
  if (typeof request.id !== 'string' || !/^[\w.-]+$/.test(request.id)) return { error: 'invalid request id' }
  if (typeof request.tool !== 'string' || !/^sub_(spawn|wait|status|digest|diff|send|merge|cleanup|kill|log|btw)$/.test(request.tool)) return { error: 'unknown tool' }
  if (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)) return { error: 'args must be an object' }
  return { id: request.id, tool: request.tool, args: request.args }
}

export function managerChildScope(caller, worker) {
  if (!caller || caller.agent !== 'manager' || !worker || worker.parent !== caller.id) return `${worker?.id ?? 'worker'} is not your sub-worker`
  return undefined
}

export function managerCostRollup(own, childCosts) {
  return own + childCosts.reduce((sum, cost) => sum + (Number.isFinite(cost) ? cost : 0), 0)
}

export function managerTokenRollup(own, childTokens) {
  return own + childTokens.reduce((sum, tokens) => sum + (Number.isFinite(tokens) ? tokens : 0), 0)
}

export function managerRollupText(children) {
  return children.map(child => `${child.id} ${child.title} — ${child.state}; files: ${child.files.join(', ') || 'none'}; cost ${child.cost <= 0 ? 'plan' : `$${child.cost.toFixed(3)}`}${child.warn?.length ? `; ⚠ ${child.warn.join('; ')}` : ''}`).join('\n')
}
