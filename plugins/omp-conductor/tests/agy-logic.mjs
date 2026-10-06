export function agyToolName(name) {
  const n = String(name ?? 'tool')
  if (n === 'run_command') return 'bash'
  if (['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit'].includes(n)) return 'edit'
  if (['view_file', 'list_dir', 'grep_search', 'find_by_name'].includes(n)) return 'read'
  return n
}

export function agyToolArgs(params) {
  const p = params && typeof params === 'object' ? params : {}
  const path = p.TargetFile ?? p.AbsolutePath ?? p.SearchPath ?? p.DirectoryPath ?? p.path
  const out = { ...p }
  if (typeof p.CommandLine === 'string') out.command = p.CommandLine
  if (typeof path === 'string') out.path = path
  return out
}

export function agyEventsToPi(ev, st) {
  const out = new Array()
  if (!ev || typeof ev !== 'object') return out
  if (ev.event === 'init') {
    const id = ev.conversation_id ?? ev.init?.conversation_id
    if (id) out.push({ type: 'response', command: 'get_state', success: true, data: { sessionId: id } })
    return out
  }
  if (ev.event === 'step_update' && ev.step_update) {
    const s = ev.step_update
    const idx = String(s.step_index)
    if (s.step_type === 'agent_response') {
      if (st.turns[idx] === undefined) {
        st.turns[idx] = ''
        out.push({ type: 'turn_start' })
      }
      if (typeof s.text_delta === 'string' && s.text_delta) {
        st.turns[idx] += s.text_delta
        out.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: s.text_delta } })
      }
      if (s.state === 'DONE') {
        const text = st.turns[idx].trim()
        if (text) out.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: text } })
        const u = s.usage ?? {}
        out.push({ type: 'turn_end', message: { role: 'assistant', usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_tokens ?? 0, cost: { total: 0 } } } })
      }
    } else if (s.step_type === 'tool') {
      const info = s.tool_info ?? {}
      const toolName = agyToolName(s.tool_name)
      const toolCallId = `${s.conversation_id}:${idx}`
      if (s.state === 'ACTIVE') out.push({ type: 'tool_execution_start', toolCallId, toolName, args: agyToolArgs(info.parameters) })
      else if (s.state === 'DONE' || /ERR|FAIL|CANCEL/i.test(String(s.state))) {
        out.push({ type: 'tool_execution_end', toolCallId, toolName, isError: s.state !== 'DONE', result: { content: [{ text: typeof info.output === 'string' ? info.output : '' }], details: {} } })
      }
    }
    return out
  }
  if (ev.event === 'result' && ev.result) {
    const r = ev.result
    if (r.status && r.status !== 'SUCCESS') out.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: String(r.error ?? r.status) } })
    out.push({ type: 'agent_settled' })
    st.turns = {}
  }
  return out
}
