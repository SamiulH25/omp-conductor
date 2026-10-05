export function parseReviewFindings(report) {
  const blocks = report.split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s)/)
  return blocks.flatMap(block => {
    const severity = block.match(/(?:\bseverity\s*[:*-]?\s*|\[\s*|\(\s*|^\s*(?:[-*+]\s*)?\*{0,2})(critical|blocker|high|medium|low)\b/i)?.[1]?.toLowerCase()
    const location = block.match(/([A-Za-z0-9_./\\@-]+:\d+(?::\d+)?)/)?.[1]
    if (!severity || !location) return []
    return [{ severity, location, text: block.trim(), blocking: ['critical', 'blocker', 'high'].includes(severity) }]
  })
}

export function rankBestOfN(results) {
  return [...results].sort((a, b) => Number(b.passed) - Number(a.passed) || a.warnings - b.warnings || a.diffSize - b.diffSize || a.id.localeCompare(b.id))
}
