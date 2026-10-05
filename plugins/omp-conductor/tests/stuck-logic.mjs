const stable = value => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}

const signature = event => `${event.tool ?? 'tool'}\0${JSON.stringify(stable(event.args ?? {}))}`

export function detectStuck(events, quietMs, thresholdMs = 4 * 60_000) {
  const findings = []
  if (quietMs >= thresholdMs) {
    findings.push({ key: 'idle', message: `possibly stuck: no activity for ${Math.floor(quietMs / 60_000)}m` })
  }

  const calls = events.filter(event => event.kind === 'tool').slice(-8)
  const counts = new Map()
  for (const event of calls) {
    const key = signature(event)
    const previous = counts.get(key)
    if (previous) previous.count += 1
    else counts.set(key, { event, count: 1 })
  }
  for (const [key, { event, count }] of counts) {
    if (count < 4) continue
    const args = event.args ?? {}
    const detail = typeof args.command === 'string' ? JSON.stringify(args.command) : JSON.stringify(args)
    findings.push({
      key: `tool:${key}`,
      message: `looping: ${event.tool ?? 'tool'} ${detail} x${count}`,
    })
  }

  const errors = events.filter(event => event.kind === 'error')
  const errorCounts = new Map()
  for (const event of errors) {
    const text = String(event.text ?? 'error')
    errorCounts.set(text, (errorCounts.get(text) ?? 0) + 1)
  }
  for (const [text, count] of errorCounts) {
    if (count >= 3) findings.push({ key: `error:${text}`, message: `looping: error ${JSON.stringify(text)} x${count}` })
  }
  return findings
}
