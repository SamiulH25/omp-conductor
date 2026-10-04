import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Act, WorkerView } from '../types'

const PANE = 'omp-conductor'
const MAX_WORKERS = 4
const MAX_EVENTS = 300
const FINAL_CHARS = 700
const FILE_LIMIT = 12
const ROOTS_EXTRA = ['/tmp']
const DENY = /\/\.(ssh|gnupg|aws|kube|docker)(\/|$)/
// The only model workers ever use. /omp-model changes it and the choice is kept in the store.
const SUMMARY_MODEL = 'haiku' // the one other model: compresses a long worker reply that has no SUMMARY block
const DEFAULT_MODEL = 'opencode-go/deepseek-v4.1-flash'
const DEFAULT_THINKING = 'high' // reasoning effort workers start with; /omp-effort changes it
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] // omp --thinking values
const STORE_PREFIX = 'workers:' // one store key per Claude session, so sessions never share records
// Avatar reactions: how long a one-shot reaction shows, and which tools count as reading or editing.
const REACT_MS = { error: 1800, write: 1200, turn: 700 } as const
const REACT_RANK = { error: 3, write: 2, turn: 1 } as const
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'find', 'search', 'ls', 'ast_grep'])
const SYNC_MS = 250 // minimum gap between pane syncs triggered by worker output
const STALE_MS = 14 * 24 * 3600 * 1000
// Project dictionary: short term -> definition entries per project root, kept in the store, injected into every worker.
const DICT_PREFIX = 'dict:'
const DICT_MAX_CHARS = 6000 // whole dictionary; keeps the injected context small
const DICT_DEF_CHARS = 300 // one definition; a dictionary entry, not an essay

// The worker simplifies its own work: every task ends with a SUMMARY block the digest quotes.
const SUFFIX =
  '\n\n---\nWhen you are finished, end your final reply with a block starting with the line "SUMMARY:" followed by at most 5 short bullets: what you did, files created or changed, anything that failed or was skipped, open questions. Plain text, under 120 words.'
const SUMMARY_RE = /(?:^|\n)[#*\s]*SUMMARY:?[*\s]*\n?([\s\S]*)$/

// Agent types: what a worker may do (a hard --tools allowlist plus a stated role) and how it reports back.
// 'summary' types condense their own work; 'detailed' types return the full report and are never compressed.
type AgentType = {
  about: string
  tools?: string[] // omp --tools allowlist; undefined = every tool
  worktree: boolean | 'auto' // default isolation ('auto' = a worktree when dir is a git repo)
  report: 'summary' | 'detailed'
  maxMinutes: number
  role: string // appended to the system prompt: states the permissions and working style
  suffix: string // appended to the task: how to end the final reply
}

const READ_ONLY = ['read', 'grep', 'glob', 'find']
const READ_ONLY_ROLE =
  'PERMISSIONS: read-only. You can read, search and list files; you cannot and must not modify, create or delete anything, run builds or change any state. Your tools are restricted accordingly; do not try to work around that. If the task needs a change, describe the change and where it belongs instead of making it.'
const DETAILED_RULES =
  'Your supervisor cannot see what you looked at, so the report is the only thing it gets. Do NOT condense it: length is fine, omission is not. Mark every claim as verified (you read it) or inferred.'

const AGENTS: Record<string, AgentType> = {
  general: {
    about: 'unrestricted, short SUMMARY (the pre-agent-types behaviour)',
    worktree: 'auto',
    report: 'summary',
    maxMinutes: 20,
    role: '',
    suffix: SUFFIX,
  },
  dev: {
    about: 'implements changes: read, edit, write, shell; short SUMMARY of what changed. Worktree by default',
    tools: [...READ_ONLY, 'edit', 'write', 'bash', 'todo'],
    worktree: 'auto',
    report: 'summary',
    maxMinutes: 20,
    role: 'You are a dev agent. PERMISSIONS: you may read, edit and create files and run shell commands, only inside the working directory and only for what the task asks. Do not touch unrelated files, do not install global packages, do not run git commit, push, checkout or reset (the supervisor commits and merges), and do not delete anything outside the task. Verify your work with the tests or checks named in the task before you finish.',
    suffix: SUFFIX,
  },
  explore: {
    about: 'read-only investigator: finds and reads code, returns a long evidence-backed FINDINGS report (never summarized). No worktree',
    tools: READ_ONLY,
    worktree: false,
    report: 'detailed',
    maxMinutes: 15,
    role: `You are an explore agent. ${READ_ONLY_ROLE} METHOD: be exhaustive. Follow references and call chains to the end, try several naming conventions and search terms before concluding something is absent, and read the actual code rather than guessing from file names. Cite file:line for every claim.`,
    suffix: `\n\n---\nWhen you are finished, end your final reply with a block starting with the line "FINDINGS:" holding your complete report: every relevant file with line numbers, short code or signatures quoted verbatim, how the pieces connect, what you searched for and did not find, and open questions or uncertainty. ${DETAILED_RULES}`,
  },
  review: {
    about: 'read-only reviewer: returns every issue found with file:line, severity and a fix (never summarized). No worktree',
    tools: READ_ONLY,
    worktree: false,
    report: 'detailed',
    maxMinutes: 15,
    role: `You are a review agent. ${READ_ONLY_ROLE} METHOD: read the code under review in full and check each claim against what it actually does. Look for correctness bugs, unhandled edge cases, broken contracts with callers, and missing tests. Do not pad with style nitpicks.`,
    suffix: `\n\n---\nWhen you are finished, end your final reply with a block starting with the line "FINDINGS:" listing every issue, most severe first. For each: severity (high/medium/low), file:line, what is wrong, a concrete failure scenario, and a suggested fix. Then list what you checked that was fine. ${DETAILED_RULES}`,
  },
}
const DEFAULT_AGENT = 'general'
const REPORT_CHARS = 60000 // a detailed report is shown whole; this is only a runaway guard (~15k tokens)
const REPORT_CHARS_FULL = 200000 // ... with detail:"full", and the most the store keeps

const workersAtom = atom({ plugin: 'omp-conductor', key: 'workers' } as const, [])
const frameAtom = atom({ plugin: 'omp-conductor', key: 'frame' } as const, 0)
const demoAtom = atom({ plugin: 'omp-conductor', key: 'demo' } as const, false)
// Everything the session has spent on workers, kept even after a worker is cleaned up.
const modelAtom = atom({ plugin: 'omp-conductor', key: 'model' } as const, 'opencode-go/deepseek-v4.1-flash')
const thinkingAtom = atom({ plugin: 'omp-conductor', key: 'thinking' } as const, 'high')
const ledgerAtom = atom({ plugin: 'omp-conductor', key: 'ledger' } as const, { cost: 0, tokens: 0, spawned: 0 })

type State = 'running' | 'done' | 'failed' | 'killed'

type Worker = {
  id: string
  title: string
  task: string
  dir: string
  root: string // git toplevel, or dir outside git; keys the project dictionary
  isGit: boolean
  worktree?: string
  branch?: string
  summary?: string
  session?: string
  model?: string
  agent: string
  act?: Act
  lastAt?: number // last event from omp; the avatar idles when this gets old
  react?: { kind: keyof typeof REACT_MS; at: number }
  reads: Set<string>
  state: State
  startedAt: number
  endedAt?: number
  files: Set<string>
  commands: string[]
  errors: string[]
  texts: string[]
  events: string[]
  last: string
  steps: number
  tokensIn: number
  tokensOut: number
  stderr: string
  isReported: boolean
  stop?: () => void
  tps?: number
  tpsAt?: number
  outTokens: number
  genMs: number
  spark: number[]
  maxMinutes?: number
  cost: number
  sawEnd: boolean
  turnChars: number
  ratio: number
  win: [number, number][]
  toolArgs: Record<string, Record<string, unknown>>
}

type Bridge = {
  sync: () => Promise<void>
  syncSoon: () => void
  launch: (w: Worker, message: string) => void
  summarize: (text: string) => Promise<string | undefined>
  git: (
    args: string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string } | undefined>
  realPath: (dir: string) => Promise<string | undefined>
  wake: (id: string) => void
  flush: () => void
  ledger: (cost: number, tokens: number, spawned: number) => Promise<void>
}

type Species = { color: string; rows: (eyes: string, mouth: string) => string[] }
const SPECIES: Species[] = [
  { color: '#61d6ff', rows: (e, m) => ['┌─▫─┐', `│${e}│`, `└─${m}─┘`] },
  { color: '#ffb86c', rows: (e, m) => ['/\\_/\\', `(${e})`, ` ╰${m}╯ `] },
  { color: '#bd93f9', rows: (e, m) => ['╭───╮', `│${e}│`, `╰┴${m}┴╯`] },
  { color: '#50fa7b', rows: (e, m) => ['╭▔▔▔╮', `{${e}}`, `╰┬${m}┬╯`] },
]

const demoList = (now: number): WorkerView[] => [
  { id: 'w1', title: 'lighthouse story', state: 'running', startedAt: now - 83_000, last: 'write story_lighthouse.md', files: 1, tokens: 31_200, cost: 0.0143, errors: 0, model: 'deepseek-v4.1-flash', act: 'edit', lastAt: now, agent: 'dev', react: Math.floor(now / 1000) % 6 === 0 ? { kind: 'write', at: now } : undefined, tps: 142, tpsAt: now, avgTps: 118, spark: [90, 120, 150, 110, 160, 142] },
  { id: 'w2', title: 'fix add() bug and add tests', state: 'running', startedAt: now - 41_000, last: 'bash python3 test_calc.py', files: 2, tokens: 18_400, cost: 0.0091, errors: 0, model: 'deepseek-v4.1-flash', act: 'bash', lastAt: now, react: Math.floor(now / 1000) % 7 === 0 ? { kind: 'error', at: now } : undefined, tps: 87, tpsAt: now, avgTps: 95, spark: [120, 95, 70, 101, 87] },
  { id: 'w6', title: 'map the save system', state: 'running', startedAt: now - 22_000, last: 'grep SaveGame', files: 0, tokens: 9_100, cost: 0.004, errors: 0, model: 'muse-spark-1.3', act: 'read', lastAt: now, agent: 'explore', tps: 64, tpsAt: now, avgTps: 60, spark: [50, 64, 70, 64] },
  { id: 'w7', title: 'review inventory diff', state: 'running', startedAt: now - 65_000, last: 'thinking', files: 0, tokens: 22_000, cost: 0.011, errors: 0, model: 'muse-spark-1.3', act: 'think', lastAt: now - 14_000, agent: 'review', avgTps: 40, spark: [40, 38] },
  { id: 'w3', title: 'readme usage section', state: 'done', startedAt: now - 190_000, endedAt: now - 150_000, last: 'read README.md', files: 1, tokens: 17_900, cost: 0.0062, errors: 0, model: 'deepseek-v4.1-flash', note: 'Appended a Usage section with a python example', avgTps: 64, spark: [40, 88, 61, 70] },
  { id: 'w4', title: 'migrate config loader', state: 'failed', startedAt: now - 300_000, endedAt: now - 262_000, last: 'bash pytest -q', files: 3, tokens: 64_000, cost: 0.0388, errors: 2, model: 'deepseek-v4-pro', err: 'bash exit 1: pytest -q', avgTps: 51, spark: [60, 45, 52] },
  { id: 'w5', title: 'long sleeper', state: 'killed', startedAt: now - 420_000, endedAt: now - 380_000, last: 'thinking', files: 0, tokens: 0, cost: 0.0, errors: 0, model: 'deepseek-v4.1-flash' },
]

const text = (s: string, isError = false) => (isError ? { deny: s } : { result: s })

const money = (c: number) => `$${c >= 1 ? c.toFixed(2) : c >= 0.01 ? c.toFixed(3) : c.toFixed(4)}`
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const one = (s: string) => s.replace(/\s+/g, ' ').trim()
const ownSummary = (w: Worker) => {
  for (let i = w.texts.length - 1; i >= 0; i--) {
    const m = SUMMARY_RE.exec(w.texts[i]!)
    if (m && m[1]!.trim()) return m[1]!.trim()
  }
  return undefined
}
const firstBullet = (s?: string) => {
  const line = s?.split('\n').find(l => l.trim())
  return line ? clip(one(line.replace(/^[\s•*-]+/, '')), 80) : undefined
}
const elapsed = (w: Worker) => {
  const sec = Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 1000)
  return sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`
}

export const register: Register = on => {
  const workers = new Map<string, Worker>()
  let B: Bridge | undefined
  let cwd = ''
  let home = ''
  let turnActive = false
  let demoOn = false
  let currentModel = DEFAULT_MODEL
  let currentThinking = DEFAULT_THINKING
  const roots = () => [cwd, home, ...ROOTS_EXTRA]
  let seq = 0

  const views = (): WorkerView[] =>
    [...workers.values()].map(w => ({
      id: w.id,
      title: w.title,
      state: w.state,
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      last: w.last,
      files: w.files.size,
      tokens: w.tokensIn + w.tokensOut,
      cost: w.cost,
      errors: w.errors.length,
      model: w.model?.split('/').at(-1),
      agent: w.agent === DEFAULT_AGENT ? undefined : w.agent,
      note: firstBullet(ownSummary(w) ?? w.summary),
      err: w.errors.at(-1) ? clip(one(w.errors.at(-1)!), 80) : undefined,
      tps: (w.state === 'running' ? liveTps(w, Date.now()) : undefined) ?? w.tps,
      tpsAt: w.state === 'running' && liveTps(w, Date.now()) ? Date.now() : w.tpsAt,
      avgTps: w.genMs > 0 ? w.outTokens / (w.genMs / 1000) : undefined,
      spark: w.spark,
      act: w.act,
      lastAt: w.lastAt,
      react: w.react,
    }))

  const running = () => [...workers.values()].filter(w => w.state === 'running').length

  const sync = () => B?.sync() ?? Promise.resolve()

  const workDir = (w: Worker) => w.worktree ?? w.dir

  // ---------------------------------------------------------------- parsing
  const note = (w: Worker, line: string) => {
    w.events.push(clip(one(line), 200))
    if (w.events.length > MAX_EVENTS) w.events.shift()
  }

  const actOf = (tool: string): Act => {
    const t = tool.toLowerCase()
    return READ_TOOLS.has(t) ? 'read' : FILE_TOOLS.has(t) ? 'edit' : t === 'bash' ? 'bash' : 'tool'
  }

  // A one-shot reaction; a stronger one is not replaced by a weaker one while it is still showing.
  const react = (w: Worker, kind: keyof typeof REACT_MS) => {
    const cur = w.react
    if (cur && Date.now() - cur.at < REACT_MS[cur.kind] && REACT_RANK[cur.kind] > REACT_RANK[kind]) return
    w.react = { kind, at: Date.now() }
  }

  const target = (input: Record<string, unknown> | undefined) => {
    const v = input?.path ?? input?.filePath ?? input?.file_path ?? input?.file
    return typeof v === 'string' ? v : undefined
  }

  const FILE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'ast_edit', 'notebook'])
  const WINDOW_MS = 2500

  // Live speed: characters streamed in the last couple of seconds, turned into tokens with a
  // ratio the previous turns calibrated against omp's own usage numbers.
  const liveTps = (w: Worker, now: number) => {
    w.win = w.win.filter(([t]) => t >= now - WINDOW_MS)
    if (!w.win.length) return undefined
    const chars = w.win.reduce((n, [, c]) => n + c, 0)
    const span = Math.max(600, now - w.win[0]![0])
    return (chars * w.ratio) / (span / 1000)
  }

  const ingest = (w: Worker, raw: string) => {
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      // omp prints plain-text errors (unknown model, bad flag) outside the JSON stream.
      w.stderr = (w.stderr + raw + '\n').slice(-2000)
      note(w, `raw: ${raw}`)
      return
    }
    w.lastAt = Date.now()
    switch (ev.type) {
      case 'session':
        if (typeof ev.id === 'string') w.session = ev.id
        break
      case 'turn_start':
        w.turnChars = 0
        w.act = 'think'
        if (w.last === 'starting') w.last = 'thinking'
        break
      case 'message_update': {
        const a = ev.assistantMessageEvent ?? {}
        if (
          typeof a.delta === 'string' &&
          (a.type === 'text_delta' || a.type === 'toolcall_delta' || a.type === 'thinking_delta')
        ) {
          w.turnChars += a.delta.length
          w.win.push([Date.now(), a.delta.length])
        } else if (a.type === 'text_end' && typeof a.content === 'string' && a.content) {
          w.texts.push(a.content)
          note(w, `text ${a.content}`)
        }
        break
      }
      case 'tool_execution_start': {
        const args = (ev.args ?? {}) as Record<string, unknown>
        w.toolArgs[String(ev.toolCallId)] = args
        w.act = actOf(String(ev.toolName ?? ''))
        w.last = clip(one(`▶ ${ev.toolName} ${ev.intent ?? target(args) ?? args.command ?? ''}`), 80)
        break
      }
      case 'tool_execution_end': {
        const tool = String(ev.toolName ?? 'tool')
        const args = w.toolArgs[String(ev.toolCallId)] ?? {}
        delete w.toolArgs[String(ev.toolCallId)]
        const file = target(args)
        const out = ((ev.result?.content ?? []) as { text?: string }[]).map(c => c?.text ?? '').join('')
        const name = tool.toLowerCase()
        if (file && !ev.isError && (FILE_TOOLS.has(name) || name === 'read')) {
          const base = `${workDir(w)}/`
          ;(name === 'read' ? w.reads : w.files).add(file.startsWith(base) ? file.slice(base.length) : file)
        }
        const cmd = typeof args.command === 'string' ? args.command : undefined
        if (name === 'bash' && cmd) {
          w.commands.push(cmd)
          const exit = ev.result?.details?.exitCode ?? /exit(?:ed)?(?: with)?(?: code)?[: ]+(\d+)/i.exec(out)?.[1]
          if (exit != null && Number(exit) !== 0) {
            w.errors.push(`bash exit ${exit}: ${clip(one(cmd), 80)}`)
            react(w, 'error')
          }
        }
        w.last = clip(one(`${tool} ${file ?? cmd ?? ''}`), 80)
        w.act = 'think'
        if (file && !ev.isError && FILE_TOOLS.has(name)) react(w, 'write')
        if (ev.isError) {
          react(w, 'error')
          const msg = clip(one(out || 'error'), 200)
          w.errors.push(`${tool}: ${msg}`)
          note(w, `ERR ${tool} ${msg}`)
        } else note(w, `${tool} ${file ?? clip(cmd ?? '', 80)}`)
        break
      }
      case 'turn_end': {
        const m = ev.message ?? {}
        const u = m.usage ?? {}
        const gen = Number(u.output ?? 0)
        w.steps += 1
        w.tokensIn += Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0)
        w.tokensOut += gen
        const cost = Number(u.cost?.total ?? 0)
        w.cost += cost
        void B?.ledger(cost, Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0) + gen, 0)
        // Exact decode speed for the turn: generated tokens over time after the first token.
        const decodeMs = Number(m.duration ?? 0) - Number(m.ttft ?? 0)
        if (gen > 0 && decodeMs >= 150) {
          w.tps = gen / (decodeMs / 1000)
          w.tpsAt = Date.now()
          w.outTokens += gen
          w.genMs += decodeMs
          w.spark.push(Math.round(w.tps))
          if (w.spark.length > 12) w.spark.shift()
        }
        if (gen > 0 && w.turnChars > 20) w.ratio = 0.5 * w.ratio + 0.5 * (gen / w.turnChars)
        w.win = []
        react(w, 'turn')
        break
      }
      case 'agent_end':
        w.sawEnd = true
        break
      default:
        break
    }
  }

  // ---------------------------------------------------------------- digest
  const digest = async (w: Worker, full = false) => {
    const lines: string[] = []
    const kind = AGENTS[w.agent] ?? AGENTS[DEFAULT_AGENT]!
    lines.push(`[${w.id}] ${w.title} — ${w.state} (${elapsed(w)}) ${w.agent} session=${w.session ?? '?'}`)
    lines.push(`dir: ${workDir(w)}${w.worktree ? ' (worktree)' : ''}`)
    const files = [...w.files]
    if (files.length) {
      lines.push(
        `wrote/edited ${files.length}: ${files.slice(0, FILE_LIMIT).join(', ')}${files.length > FILE_LIMIT ? ', …' : ''}`,
      )
    }
    if (kind.report === 'detailed' && w.reads.size) lines.push(`read ${w.reads.size} file${w.reads.size === 1 ? '' : 's'}`)
    if (w.commands.length) {
      lines.push(
        `commands ${w.commands.length}, last: ${w.commands
          .slice(-4)
          .map(c => clip(one(c), 70))
          .join(' | ')}`,
      )
    }
    if (w.isGit) {
      const st = await B?.git(['status', '--short'], workDir(w))
      const out = st?.stdout.trim()
      if (out) {
        const rows = out.split('\n')
        lines.push(`git status (${rows.length}): ${rows.slice(0, FILE_LIMIT).join('; ')}`)
      }
    }
    if (w.errors.length) {
      lines.push(`errors ${w.errors.length}: ${w.errors.slice(-3).join(' | ')}`)
    }
    if (w.state !== 'running' && w.stderr.trim()) lines.push(`stderr: ${clip(one(w.stderr), 300)}`)
    const avg = w.genMs > 0 ? `, ~${Math.round(w.outTokens / (w.genMs / 1000))} tok/s` : ''
    lines.push(`steps ${w.steps}, tokens in/out ${w.tokensIn}/${w.tokensOut}${avg}, cost ${money(w.cost)}`)
    const final = w.texts.at(-1)?.trim()
    const own = ownSummary(w)
    if (kind.report === 'detailed' && final && w.state !== 'running') {
      // Explore and review agents: the whole report, never compressed.
      const cap = full ? REPORT_CHARS_FULL : REPORT_CHARS
      lines.push(`report${final.length > cap ? ` (first ${cap} of ${final.length} chars; detail:"full" for more)` : ''}:`, clip(final, cap))
    } else if (own) {
      lines.push(`summary (worker's own): ${clip(own, 800)}`)
    } else if (final && w.state !== 'running' && final.length > FINAL_CHARS && !full) {
      w.summary ??= await B?.summarize(final)
      lines.push(
        w.summary ? `summary (haiku): ${w.summary}` : `final: ${clip(final, FINAL_CHARS)}`,
      )
    } else if (final) {
      lines.push(`final: ${clip(final, full ? 4000 : FINAL_CHARS)}`)
    } else lines.push(`last action: ${w.last || 'none yet'}`)
    if (full && own && final && kind.report !== 'detailed') lines.push(`full final: ${clip(final, 4000)}`)
    if (full) lines.push('--- events ---', ...w.events.slice(-60))
    return lines.join('\n')
  }

  const insideRoots = async (dir: string) => {
    const real = await B?.realPath(dir)
    if (!real) return false
    if (DENY.test(real)) return false
    return roots().some(r => r && (real === r || real.startsWith(`${r}/`)))
  }

  const pick = (e: Record<string, unknown>) => {
    const id = typeof e.id === 'string' ? e.id : ''
    return workers.get(id)
  }

  // ---------------------------------------------------------------- hooks
  on('session.start', async ($, e, next) => {
    cwd = (e as { cwd?: string }).cwd ?? ''
    home = (await $.process.run(['printenv', 'HOME']).catch(() => undefined))?.stdout.trim() ?? ''

    // Everything that needs `$` for the session's life is built here, where it is in scope.
    let wakeTimer: (() => void) | undefined
    let syncTimer: (() => void) | undefined
    const pendingWake = new Set<string>()

    currentModel = String((await $.store.get('model').catch(() => undefined)) || DEFAULT_MODEL)
    await update($, modelAtom, () => currentModel)
    const savedThinking = String((await $.store.get('thinking').catch(() => undefined)) || DEFAULT_THINKING)
    currentThinking = THINKING_LEVELS.includes(savedThinking) ? savedThinking : DEFAULT_THINKING
    await update($, thinkingAtom, () => currentThinking)
    let lastSig = ''
    const storeKey = `${STORE_PREFIX}${await $.session.id()}`
    const record = (w: Worker) => ({
      id: w.id,
      title: w.title,
      task: clip(w.task, 500),
      dir: w.dir,
      root: w.root,
      isGit: w.isGit,
      worktree: w.worktree,
      branch: w.branch,
      session: w.session,
      model: w.model,
      agent: w.agent,
      state: w.state,
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      files: [...w.files],
      reads: [...w.reads].slice(0, 200),
      commands: w.commands.slice(-10),
      errors: w.errors.slice(-5),
      last: w.last,
      steps: w.steps,
      tokensIn: w.tokensIn,
      tokensOut: w.tokensOut,
      finalText: clip(w.texts.at(-1) ?? '', AGENTS[w.agent]?.report === 'detailed' ? REPORT_CHARS_FULL : 4000),
      summary: w.summary,
      outTokens: w.outTokens,
      genMs: w.genMs,
      spark: w.spark,
      maxMinutes: w.maxMinutes,
      cost: w.cost,
    })

    // Bring back what an earlier load knew, so a reload keeps ids and sessions (omp_send still works).
    const saved = (await $.store.get(storeKey).catch(() => undefined)) as
      | { at: number; workers: ReturnType<typeof record>[] }
      | undefined
    if (saved && Array.isArray(saved.workers)) {
      for (const r of saved.workers) {
        const was = r.state === 'running'
        workers.set(r.id, {
          ...r,
          root: r.root ?? r.dir,
          agent: AGENTS[r.agent] ? r.agent : DEFAULT_AGENT,
          files: new Set(r.files),
          reads: new Set(r.reads ?? []),
          texts: r.finalText ? [r.finalText] : [],
          events: [],
          stderr: '',
          state: was ? 'killed' : r.state,
          last: was ? 'interrupted by a reload' : r.last,
          endedAt: r.endedAt ?? (was ? Date.now() : undefined),
          isReported: true,
          outTokens: r.outTokens ?? 0,
          genMs: r.genMs ?? 0,
          spark: r.spark ?? [],
          cost: r.cost ?? 0,
          sawEnd: true,
          turnChars: 0,
          ratio: 0.28,
          win: [],
          toolArgs: {},
        })
        seq = Math.max(seq, Number(r.id.replace(/\D/g, '')) || 0)
      }
    }

    // Housekeeping: drop the old machine-wide key and the records of long-dead sessions.
    void (async () => {
      const keys = await $.store.keys().catch(() => [] as string[])
      for (const k of keys) {
        if (k === 'workers') {
          await $.store.delete(k).catch(() => undefined)
        } else if (k.startsWith(STORE_PREFIX) && k !== storeKey) {
          const other = (await $.store.get(k).catch(() => undefined)) as { at?: number } | undefined
          if (!other?.at || Date.now() - other.at > STALE_MS) await $.store.delete(k).catch(() => undefined)
        }
      }
    })()

    // Project dictionary: the supervisor's own glossary of the project, injected into every worker's system prompt.
    type Dict = Record<string, { def: string; at: number }>
    const loadDict = async (root: string): Promise<Dict> => {
      const d = (await $.store.get(DICT_PREFIX + root).catch(() => undefined)) as Dict | undefined
      return d && typeof d === 'object' ? d : {}
    }
    const dictBody = (d: Dict) =>
      Object.entries(d)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([term, v]) => `- ${term}: ${v.def}`)
        .join('\n')
    const dictText = async (root: string) => {
      const body = dictBody(await loadDict(root))
      return body
        ? `PROJECT DICTIONARY (kept by your supervisor: the project's terms, systems and where they live. Use it to skip re-learning the layout. It can be stale: if the code contradicts an entry, trust the code and say so in your report.)\n${body}`
        : ''
    }

    B = {
      summarize: async body => {
        const r = await $.model.complete({
          model: SUMMARY_MODEL,
          maxTokens: 220,
          system: 'You compress the final reply of a coding worker for its supervisor. Always produce the summary; never refuse, never ask for more input, never comment on the request. Be factual and add nothing the text does not say.',
          prompt: `Summarize the text below in at most 5 short bullets (under 100 words). Cover what was done, files touched, what failed or was skipped, and open questions where the text mentions them; if it is not a work report, summarize its content.\n\n<text>\n${clip(body, 6000)}\n</text>`,
        })
        return r.isAnswered ? r.text.trim() : undefined
      },

      ledger: async (cost, tokens, spawned) => {
        await update($, ledgerAtom, l => ({
          cost: (l?.cost ?? 0) + cost,
          tokens: (l?.tokens ?? 0) + tokens,
          spawned: (l?.spawned ?? 0) + spawned,
        }))
      },

      sync: async () => {
        const all0 = [...workers.values()]
        const sig = all0.map(w => `${w.id}:${w.state}:${w.session ?? ''}:${w.files.size}:${w.steps}`).join(',')
        if (sig !== lastSig) {
          lastSig = sig
          await $.store
            .set(storeKey, { at: Date.now(), workers: all0.map(record) })
            .catch(() => undefined)
        }
        await update($, workersAtom, () => views())
        const all = [...workers.values()]
        const n = (s: State) => all.filter(w => w.state === s).length
        const led = await read($, ledgerAtom)
        $.ui.status(
          all.length === 0 && !led.spawned
            ? undefined
            : `omp ${n('running')} running · ${n('done')} done${n('failed') ? ` · ${n('failed')} failed` : ''} · ${money(led.cost)}`,
        )
      },

      // Stream chunks arrive far faster than the pane can use: coalesce them into one sync per SYNC_MS.
      syncSoon: () => {
        if (syncTimer) return
        syncTimer = $.clock.after(SYNC_MS, () => {
          syncTimer = undefined
          void B?.sync()
        })
      },

      git: (args, dir) =>
        $.process.run(['git', ...args], { cwd: dir, timeoutMs: 30_000 }).catch(() => undefined),

      realPath: async dir => {
        const st = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
        return (st as { realPath?: string } | undefined)?.realPath
      },

      // A wake-up prompt waits for an idle session, so one sent mid-turn arrives after the
      // worker was already reviewed. Hold it while a turn runs and re-check at the turn's end.
      wake: id => {
        pendingWake.add(id)
        wakeTimer?.()
        wakeTimer = $.clock.after(2000, () => {
          if (!turnActive) B?.flush()
        })
      },

      flush: () => {
        const ids = [...pendingWake].filter(i => workers.get(i)?.isReported === false)
        pendingWake.clear()
        if (!ids.length) return
        const brief = ids.map(i => `${i} (${workers.get(i)!.state})`).join(', ')
        void $.prompt.submit({
          text: `omp-conductor: worker(s) finished: ${brief}. Review with omp_digest / omp_diff, then omp_merge, omp_send a correction, or re-spawn.`,
        })
      },

      launch: (w, message) => {
        if (w.session) w.startedAt = Date.now()
        w.state = 'running'
        w.endedAt = undefined
        w.stderr = ''
        w.isReported = false
        w.sawEnd = false
        w.win = []
        void (async () => {
          const argv = [
            'omp', '-p', '--mode', 'json', '--cwd', workDir(w),
            '--approval-mode', 'yolo', '--no-title', '--max-time', `${w.maxMinutes ?? 20}m`,
          ]
          w.model = currentModel
          argv.push('--model', currentModel)
          argv.push('--thinking', currentThinking)
          const kind = AGENTS[w.agent] ?? AGENTS[DEFAULT_AGENT]!
          if (kind.tools) argv.push('--tools', kind.tools.join(','))
          const dict = await dictText(w.root)
          const sys = [kind.role, dict].filter(Boolean).join('\n\n')
          if (sys) argv.push('--append-system-prompt', sys)
          if (w.session) argv.push('--resume', w.session)
          const body = message + kind.suffix
          argv.push(body.startsWith('-') ? `Task: ${body}` : body)
          let killed = false
          const it = $.process.spawn({ argv, cwd: workDir(w) })[Symbol.asyncIterator]()
          w.stop = () => {
            killed = true
            void it.return?.(undefined as never)
          }
          let buf = ''
          let code: number | null = null
          try {
            for (;;) {
              const step = await it.next()
              if (step.done) {
                code = step.value?.code ?? null
                break
              }
              const { stream: pipe, text: chunk } = step.value
              if (pipe === 'stderr') {
                w.stderr = (w.stderr + chunk).slice(-2000)
                continue
              }
              buf += chunk
              let nl = buf.indexOf('\n')
              while (nl >= 0) {
                const line = buf.slice(0, nl).trim()
                buf = buf.slice(nl + 1)
                if (line) ingest(w, line)
                nl = buf.indexOf('\n')
              }
              B?.syncSoon()
            }
            if (buf.trim()) ingest(w, buf.trim())
          } catch (err) {
            w.errors.push(`spawn: ${String((err as Error)?.message ?? err)}`)
            code = -1
          }
          w.endedAt = Date.now()
          w.stop = undefined
          w.state = killed ? 'killed' : code === 0 && w.sawEnd ? 'done' : 'failed'
          if (w.state === 'failed') w.errors.push(`omp exited ${code}${w.sawEnd ? '' : ' before finishing'}`)
          await sync()
          $.ui.toast(`omp ${w.id} ${w.state}: ${w.title}`)
          if (!killed) B?.wake(w.id)
        })()
      },
    }

    const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
      type: 'object',
      properties,
      required,
    })
    const idProp = { id: { type: 'string', description: 'Worker id from omp_spawn' } }

    await $.tool.register({
      name: 'omp_spawn',
      description:
        'Start an omp worker in the background on a self-contained task and return its id at once. Workers always use the model the user set with /omp-model (not selectable here). Give it a complete standalone brief (it has no access to this conversation). Use disjoint dirs or let worktree isolation separate parallel workers. Then use omp_wait / omp_digest to read compact results and judge them.',
      inputSchema: obj(
        {
          task: { type: 'string', description: 'Complete standalone instructions for the worker' },
          dir: { type: 'string', description: 'Working directory (default: session cwd)' },
          title: { type: 'string', description: 'Short label' },
          agent: {
            type: 'string',
            enum: Object.keys(AGENTS),
            description: `Agent type (default ${DEFAULT_AGENT}). ${Object.entries(AGENTS).map(([k, a]) => `${k}: ${a.about}`).join('; ')}`,
          },
          maxMinutes: { type: 'number', description: 'hard time limit for the run (default depends on agent type, 15-20)' },
          worktree: {
            type: 'boolean',
            description: 'Isolate in a new git worktree (default depends on agent type; dev and general: true when dir is a git repo, explore and review: false)',
          },
        },
        ['task'],
      ),
    })
    await $.tool.register({
      name: 'omp_dict',
      description:
        'The project dictionary: short term -> definition entries (what a system is called, what it does, where it lives, conventions, how to run tests) that are injected into every worker for that project. Seed it from what you already understand BEFORE the first omp_spawn; after reviewing a worker, add facts you verified (never unverified worker claims). Not for task notes or history. action: show | set (upsert entries) | remove (terms).',
      inputSchema: obj(
        {
          action: { type: 'string', enum: ['show', 'set', 'remove'] },
          dir: { type: 'string', description: 'Any directory inside the project (default: session cwd)' },
          entries: {
            type: 'array',
            description: `For set: [{term, definition}]. Definitions are one or two sentences (max ${DICT_DEF_CHARS} chars); name file paths.`,
            items: obj({ term: { type: 'string' }, definition: { type: 'string' } }, ['term', 'definition']),
          },
          terms: { type: 'array', items: { type: 'string' }, description: 'For remove' },
        },
        ['action'],
      ),
    })
    await $.tool.register({
      name: 'omp_status',
      description: 'One line per omp worker: state, elapsed, last action, files touched.',
      inputSchema: obj({}),
    })
    await $.tool.register({
      name: 'omp_digest',
      description:
        'Compact report of one worker: files changed, commands, errors, final message, git status. detail "full" adds recent raw events. Treat claims as unverified; check with omp_diff.',
      inputSchema: obj(
        { ...idProp, detail: { type: 'string', enum: ['brief', 'full'] } },
        ['id'],
      ),
    })
    await $.tool.register({
      name: 'omp_wait',
      description:
        'Wait until the given workers (default: all running) finish or timeoutSec passes (max 90 per call; call again to keep waiting), then return their digests.',
      inputSchema: obj({
        ids: { type: 'array', items: { type: 'string' } },
        timeoutSec: { type: 'number' },
        mode: { type: 'string', enum: ['all', 'any'], description: 'default all' },
      }),
    })
    await $.tool.register({
      name: 'omp_send',
      description:
        'Send a follow-up message to a worker in its same omp session (the worker must not be running).',
      inputSchema: obj(
        { ...idProp, message: { type: 'string' } },
        ['id', 'message'],
      ),
    })
    await $.tool.register({
      name: 'omp_diff',
      description: 'git diff (with stat) of a worker\'s directory so you can review the real changes.',
      inputSchema: obj({ ...idProp, maxChars: { type: 'number' } }, ['id']),
    })
    await $.tool.register({
      name: 'omp_kill',
      description: 'Abort a running worker.',
      inputSchema: obj(idProp, ['id']),
    })

    await $.tool.register({
      name: 'omp_merge',
      description:
        "Commit a finished worker's worktree changes and merge its branch (--no-ff) into the repo it was spawned from. Refuses while the worker runs or the main tree has tracked changes; aborts and reports on conflict.",
      inputSchema: obj({ ...idProp, message: { type: 'string', description: 'Merge commit message' } }, ['id']),
    })
    await $.tool.register({
      name: 'omp_cleanup',
      description:
        "Remove a finished worker's worktree and branch and forget the worker. Refuses if it has unmerged work unless force is true.",
      inputSchema: obj({ ...idProp, force: { type: 'boolean' } }, ['id']),
    })

    await $.command.register({ name: 'conductor', description: 'Show the omp-conductor workers pane' })
    await $.command.register({ name: 'omp-model', description: 'Show or change the model every omp worker uses' })
    await $.command.register({ name: 'omp-effort', description: 'Show or change the reasoning effort every omp worker uses' })

    $.clock.every(1000, () => {
      if (running() > 0) void sync()
    })
    // The pane's animation clock: one tick per frame, only while a worker runs.
    $.clock.every(200, () => {
      if (running() > 0 || demoOn) void update($, frameAtom, n => (n ?? 0) + 1)
    })

    return next(e)
  })

  on('turn.start', async (_$, e, next) => {
    turnActive = true
    return next(e)
  })

  on('turn.complete', async (_$, e, next) => {
    turnActive = false
    B?.flush()
    return next(e)
  })

  on('session.end', async (_$, e, next) => {
    const live = [...workers.values()].filter(w => w.state === 'running')
    for (const w of live) w.stop?.()
    return next(e)
  })

  on('command.run', { command: 'omp-model' }, async ($, e) => {
    const arg = String((e as { args?: string }).args ?? '').trim()
    const set = async (m: string) => {
      currentModel = m
      await $.store.set('model', m).catch(() => undefined)
      await update($, modelAtom, () => m)
    }
    const status = `worker model: ${currentModel}${currentModel === DEFAULT_MODEL ? ' (plugin default)' : ` (plugin default is ${DEFAULT_MODEL})`}`
    if (!arg) {
      return { text: `${status}\nChange it: /omp-model <provider/model or part of a name>. Reset: /omp-model reset. List: omp models.` }
    }
    if (arg === 'reset' || arg === 'default') {
      await set(DEFAULT_MODEL)
      return { text: `worker model reset to ${DEFAULT_MODEL}. Applies to workers started or resumed from now on.` }
    }
    const query = arg.includes('/') ? arg.split('/').slice(1).join('/') : arg
    const r = await $.process.run(['omp', 'models', 'find', query, '--json'], { timeoutMs: 30_000 }).catch(() => undefined)
    let models: { selector: string; kind?: string; thinking?: string[]; cost?: { input: number; output: number } }[] = []
    try {
      models = (JSON.parse(r?.stdout ?? '{}').models ?? []).filter((m: { kind?: string }) => !m.kind || m.kind === 'chat')
    } catch {
      return { text: `could not read the model list from omp (is it installed and logged in?). ${status}` }
    }
    const exact = models.filter(m => m.selector === arg)
    const hits = exact.length ? exact : models.filter(m => m.selector.includes(arg) || !arg.includes('/'))
    if (!hits.length) return { text: `no omp model matches "${arg}". ${status}` }
    if (hits.length > 1) {
      const list = hits.slice(0, 10).map(m => `  ${m.selector}`).join('\n')
      return { text: `${hits.length} models match "${arg}"; pass the exact selector:\n${list}${hits.length > 10 ? '\n  …' : ''}\n${status}` }
    }
    const m = hits[0]!
    await set(m.selector)
    const note = m.thinking?.length && !m.thinking.includes(currentThinking) ? ` Warning: it lists thinking levels ${m.thinking.join(', ')} but workers ask for "${currentThinking}"; change it with /omp-effort.` : ''
    const price = m.cost ? ` ($${m.cost.input}/M in, $${m.cost.output}/M out)` : ''
    return { text: `worker model set to ${m.selector}${price}. Applies to workers started or resumed from now on; running workers keep theirs.${note}` }
  })

  on('command.run', { command: 'omp-effort' }, async ($, e) => {
    const arg = String((e as { args?: string }).args ?? '').trim().toLowerCase()
    const status = `worker effort: ${currentThinking}${currentThinking === DEFAULT_THINKING ? ' (plugin default)' : ` (plugin default is ${DEFAULT_THINKING})`}`
    if (!arg) {
      return { text: `${status}\nChange it: /omp-effort <${THINKING_LEVELS.join('|')}>. Reset: /omp-effort reset.` }
    }
    const level = arg === 'reset' || arg === 'default' ? DEFAULT_THINKING : arg
    if (!THINKING_LEVELS.includes(level)) {
      return { text: `unknown effort "${arg}". Levels: ${THINKING_LEVELS.join(', ')}. ${status}` }
    }
    currentThinking = level
    await $.store.set('thinking', level).catch(() => undefined)
    await update($, thinkingAtom, () => level)
    const r = await $.process.run(['omp', 'models', 'find', currentModel.split('/').slice(1).join('/') || currentModel, '--json'], { timeoutMs: 30_000 }).catch(() => undefined)
    let listed: string[] | null | undefined
    try {
      listed = (JSON.parse(r?.stdout ?? '{}').models ?? []).find((m: { selector: string }) => m.selector === currentModel)?.thinking
    } catch {
      listed = undefined
    }
    const note = listed?.length && !listed.includes(level) && level !== 'off' && level !== 'auto' ? ` Warning: ${currentModel} lists thinking levels ${listed.join(', ')}; omp may clamp "${level}".` : ''
    return { text: `worker effort set to ${level}. Applies to workers started or resumed from now on; running workers keep theirs.${note}` }
  })

  on('command.run', { command: 'conductor' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'omp workers' })
    const arg = String((e as { args?: string }).args ?? '').trim()
    if (arg === 'demo') {
      demoOn = !demoOn
      await update($, demoAtom, () => demoOn)
      return { text: `conductor demo ${demoOn ? 'on' : 'off'} (sample workers in every state).` }
    }
    await sync()
    return { text: `${workers.size} worker(s), ${running()} running.` }
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_spawn' }, async ($, e) => {
    const task = String(e.task ?? '').trim()
    if (!task) return text('task is required', true)
    if (running() >= MAX_WORKERS) {
      return text(`max ${MAX_WORKERS} concurrent workers; wait for one to finish first`, true)
    }
    const agent = String(e.agent ?? DEFAULT_AGENT)
    const kind = AGENTS[agent]
    if (!kind) return text(`unknown agent "${agent}"; choose one of: ${Object.keys(AGENTS).join(', ')}`, true)
    const dir = String(e.dir ?? cwd)
    if (!(await B?.realPath(dir))) return text(`dir ${dir} does not exist`, true)
    if (!(await insideRoots(dir))) {
      return text(`dir ${dir} is outside the allowed roots (${roots().filter(Boolean).join(', ')}) or is a protected dir`, true)
    }
    seq += 1
    const id = `w${seq}`
    const top = await $.process
      .run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 })
      .catch(() => undefined)
    const isGit = top?.exitCode === 0
    let worktree: string | undefined
    let branch: string | undefined
    const wantTree = e.worktree === undefined ? kind.worktree === 'auto' && isGit : e.worktree === true
    if (wantTree) {
      if (!isGit) return text('worktree requested but dir is not a git repo', true)
      const root = top!.stdout.trim()
      const parent = root.slice(0, root.lastIndexOf('/')) || '/'
      const name = root.slice(root.lastIndexOf('/') + 1)
      const tag = Date.now().toString(36)
      const path = `${parent}/.omp-worktrees/${name}-${id}-${tag}`
      const made = await $.process.run(['git', 'worktree', 'add', '-b', `omp/${name}-${id}-${tag}`, path], {
        cwd: root,
        timeoutMs: 60_000,
      })
      if (made.exitCode !== 0) return text(`git worktree failed: ${made.stderr.trim()}`, true)
      worktree = path
      branch = `omp/${name}-${id}-${tag}`
    }
    const w: Worker = {
      id,
      title: String(e.title ?? clip(one(task), 40)),
      task,
      dir,
      root: isGit ? top!.stdout.trim() : dir,
      isGit,
      worktree,
      branch,
      model: currentModel,
      agent,
      state: 'running',
      startedAt: Date.now(),
      files: new Set(),
      reads: new Set(),
      commands: [],
      errors: [],
      texts: [],
      events: [],
      last: 'starting',
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      stderr: '',
      isReported: false,
      outTokens: 0,
      genMs: 0,
      spark: [],
      maxMinutes: typeof e.maxMinutes === 'number' && e.maxMinutes > 0 ? Math.min(e.maxMinutes, 240) : kind.maxMinutes,
      cost: 0,
      sawEnd: false,
      turnChars: 0,
      ratio: 0.28,
      win: [],
      toolArgs: {},
    }
    workers.set(id, w)
    void B?.ledger(0, 0, 1)
    B?.launch(w, task)
    await sync()
    const seeded = Object.keys(((await $.store.get(DICT_PREFIX + w.root).catch(() => undefined)) as object | undefined) ?? {}).length > 0
    return text(
      `started ${id} [${agent}] "${w.title}" in ${workDir(w)}` +
        (seeded ? '' : `\nNo project dictionary for ${w.root} yet. Seed one with omp_dict (set) before the next spawn so workers stop re-learning the project.`),
    )
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_dict' }, async ($, e) => {
    const action = String(e.action ?? '')
    const dir = String(e.dir ?? cwd)
    if (!(await B?.realPath(dir))) return text(`dir ${dir} does not exist`, true)
    if (!(await insideRoots(dir))) return text(`dir ${dir} is outside the allowed roots or is a protected dir`, true)
    const top = await $.process
      .run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 })
      .catch(() => undefined)
    const root = top?.exitCode === 0 ? top.stdout.trim() : dir
    const key = DICT_PREFIX + root
    const dict = ((await $.store.get(key).catch(() => undefined)) as Record<string, { def: string; at: number }> | undefined) ?? {}
    const render = () => {
      const body = Object.entries(dict)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([term, v]) => `- ${term}: ${v.def}`)
        .join('\n')
      return `${root}: ${Object.keys(dict).length} entries, ${body.length}/${DICT_MAX_CHARS} chars${body ? `\n${body}` : ''}`
    }
    if (action === 'show') return text(render())
    if (action === 'set') {
      const entries = Array.isArray(e.entries) ? (e.entries as { term?: unknown; definition?: unknown }[]) : []
      if (!entries.length) return text('entries is required for set', true)
      const next = { ...dict }
      for (const it of entries) {
        const term = one(String(it.term ?? ''))
        const def = one(String(it.definition ?? ''))
        if (!term || !def) return text('every entry needs a term and a definition', true)
        if (def.length > DICT_DEF_CHARS) return text(`definition of "${term}" is ${def.length} chars; keep it under ${DICT_DEF_CHARS} (point at a file instead of explaining it)`, true)
        next[term] = { def, at: Date.now() }
      }
      const size = Object.entries(next).reduce((n, [t, v]) => n + t.length + v.def.length + 4, 0)
      if (size > DICT_MAX_CHARS) return text(`dictionary would be ${size} chars (max ${DICT_MAX_CHARS}); remove or tighten entries first`, true)
      await $.store.set(key, next).catch(() => undefined)
      Object.assign(dict, next)
      return text(`saved ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}. ${render().split('\n')[0]}`)
    }
    if (action === 'remove') {
      const terms = Array.isArray(e.terms) ? (e.terms as unknown[]).map(t => one(String(t))) : []
      if (!terms.length) return text('terms is required for remove', true)
      const gone = terms.filter(t => t in dict)
      for (const t of gone) delete dict[t]
      await $.store.set(key, dict).catch(() => undefined)
      return text(`removed ${gone.length}/${terms.length}. ${render().split('\n')[0]}`)
    }
    return text('action must be show, set or remove', true)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_status' }, async $ => {
    const led = await read($, ledgerAtom)
    if (!workers.size) return text(`no workers · session ${money(led.cost)}`)
    return text(
      [...workers.values()]
        .map(w => {
          const r = (w.state === 'running' ? liveTps(w, Date.now()) : undefined) ?? w.tps
          return `[${w.id}] ${w.state} ${elapsed(w)} files=${w.files.size}${r ? ` ⚡${Math.round(r)}tok/s` : ''} ${money(w.cost)} — ${w.title} — ${w.last}`
        })
        .concat(`session total ${money(led.cost)} · ${led.spawned} spawned`)
        .join('\n'),
    )
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_digest' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state !== 'running') w.isReported = true
    return text(await digest(w, e.detail === 'full'))
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_wait' }, async ($, e, next) => {
    const ids = Array.isArray(e.ids) && e.ids.length
      ? (e.ids as string[])
      : [...workers.values()].filter(w => w.state === 'running').map(w => w.id)
    const list = ids.map(i => workers.get(i)).filter((w): w is Worker => !!w)
    if (!list.length) return text('nothing to wait for')
    const limitMs = Math.min(Math.max(Number(e.timeoutSec ?? 60), 1), 90) * 1000
    const start = Date.now()
    const any = e.mode === 'any'
    for (;;) {
      const done = list.filter(w => w.state !== 'running')
      if (any ? done.length > 0 : done.length === list.length) break
      if (Date.now() - start >= limitMs) break
      // $.clock.sleep would spend the hook's 10 s budget; a $ call in flight does not.
      await $.process.run(['sleep', '1'], { timeoutMs: 5000 }).catch(() => undefined)
      if (next.signal.aborted) break
    }
    const parts: string[] = []
    for (const w of list) {
      if (w.state !== 'running') w.isReported = true
      parts.push(await digest(w))
    }
    const still = list.filter(w => w.state === 'running').length
    if (still) parts.push(`(${still} still running; call omp_wait again)`)
    return text(parts.join('\n\n'))
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_send' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state === 'running') return text(`${w.id} is still running`, true)
    if (!w.session) return text(`${w.id} has no session id to continue`, true)
    if (running() >= MAX_WORKERS) return text(`max ${MAX_WORKERS} concurrent workers`, true)
    const message = String(e.message ?? '').trim()
    if (!message) return text('message is required', true)
    w.texts = []
    w.errors = []
    B?.launch(w, message)
    await sync()
    return text(`sent to ${w.id}`)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_diff' }, async ($, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (!w.isGit) return text(`${w.id} is not in a git repo`, true)
    const cap = Math.min(Math.max(Number(e.maxChars ?? 8000), 500), 40000)
    const cwdW = workDir(w)
    const stat = await $.process.run(['git', 'diff', '--stat', 'HEAD'], { cwd: cwdW, timeoutMs: 20_000 })
    const diff = await $.process.run(['git', 'diff', 'HEAD'], { cwd: cwdW, timeoutMs: 20_000 })
    const untracked = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard'], {
      cwd: cwdW,
      timeoutMs: 20_000,
    })
    const out = [
      stat.stdout.trim() || '(no tracked changes)',
      untracked.stdout.trim() ? `untracked:\n${untracked.stdout.trim()}` : '',
      clip(diff.stdout, cap),
    ]
      .filter(Boolean)
      .join('\n\n')
    return text(out)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_kill' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state !== 'running') return text(`${w.id} is already ${w.state}`)
    w.stop?.()
    return text(`killed ${w.id}`)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_merge' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state === 'running') return text(`${w.id} is still running`, true)
    if (!w.worktree || !w.branch) return text(`${w.id} has no worktree to merge`, true)
    if (!B) return text('not ready', true)
    const dirty = await B.git(['status', '--porcelain', '--untracked-files=no'], w.dir)
    if (dirty?.stdout.trim()) {
      return text(`main tree ${w.dir} has tracked changes; commit or stash them first`, true)
    }
    await B.git(['add', '-A'], w.worktree)
    const staged = await B.git(['diff', '--cached', '--quiet'], w.worktree)
    if (staged?.exitCode === 1) {
      const c = await B.git(
        ['-c', 'user.name=omp-conductor', '-c', 'user.email=omp-conductor@localhost', 'commit', '-m', `${w.title} (${w.id})`],
        w.worktree,
      )
      if (c?.exitCode !== 0) return text(`commit failed: ${c?.stderr.trim() ?? 'unknown'}`, true)
    }
    const ahead = await B.git(['rev-list', '--count', `HEAD..${w.branch}`], w.dir)
    if (Number(ahead?.stdout.trim() ?? 0) === 0) return text(`${w.id}: nothing to merge`)
    const msg = String(e.message ?? `omp merge ${w.id}: ${w.title}`)
    const m = await B.git(
      ['-c', 'user.name=omp-conductor', '-c', 'user.email=omp-conductor@localhost', 'merge', '--no-ff', '-m', msg, w.branch],
      w.dir,
    )
    if (m?.exitCode !== 0) {
      const files = await B.git(['diff', '--name-only', '--diff-filter=U'], w.dir)
      await B.git(['merge', '--abort'], w.dir)
      return text(
        `merge conflict, aborted. conflicting: ${files?.stdout.trim().split('\n').join(', ') || m?.stderr.trim()}`,
        true,
      )
    }
    const stat = await B.git(['diff', '--stat', 'HEAD~1', 'HEAD'], w.dir)
    return text(`merged ${w.branch} into ${w.dir}\n${stat?.stdout.trim() ?? ''}`)
  })

  on('tool.call', { tool: 'mcp__omp-conductor__omp_cleanup' }, async (_$, e) => {
    const w = pick(e)
    if (!w) return text(`no worker ${String(e.id)}`, true)
    if (w.state === 'running') return text(`${w.id} is still running; omp_kill it first`, true)
    if (!B) return text('not ready', true)
    if (w.worktree && w.branch) {
      if (e.force !== true) {
        const dirty = await B.git(['status', '--porcelain'], w.worktree)
        const ahead = await B.git(['rev-list', '--count', `HEAD..${w.branch}`], w.dir)
        if (dirty?.stdout.trim() || Number(ahead?.stdout.trim() ?? 0) > 0) {
          return text(`${w.id} has unmerged work; omp_merge it first or pass force:true`, true)
        }
      }
      const rm = await B.git(['worktree', 'remove', '--force', w.worktree], w.dir)
      if (rm?.exitCode !== 0) return text(`worktree remove failed: ${rm?.stderr.trim()}`, true)
      await B.git(['branch', '-D', w.branch], w.dir)
    }
    workers.delete(w.id)
    await sync()
    return text(`cleaned up ${w.id}`)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const demo = await read($, demoAtom)
    const modelNow = await read($, modelAtom)
    const thinkingNow = await read($, thinkingAtom)
    const realLedger = await read($, ledgerAtom)
    const real = await read($, workersAtom)
    const list = demo ? demoList(Date.now()) : real
    const ledger = demo ? { cost: 0.0684, tokens: 131_500, spawned: 7 } : realLedger
    const frame = await read($, frameAtom)
    const cols = Math.max(30, Number((e.props as { bodyColumns?: number })?.bodyColumns ?? e.viewport?.columns ?? 60))
    const rows = e.viewport?.rows ?? 30
    const now = Date.now()

    const num = (id: string) => Number(id.replace(/\D/g, '')) || 0
    const mmss = (ms: number) => {
      const t = Math.max(0, Math.round(ms / 1000))
      return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
    }
    const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
    const BLOCKS = '▁▂▃▄▅▆▇█'
    const sparkOf = (xs?: number[]) => {
      if (!xs?.length) return ''
      const max = Math.max(...xs, 1)
      return xs.map(x => BLOCKS[Math.min(7, Math.round((x / max) * 7))]).join('')
    }
    const rateOf = (w: (typeof list)[number]) => {
      const fresh = w.state === 'running' && w.tps && w.tpsAt && now - w.tpsAt < 15_000
      if (fresh) return { v: w.tps!, text: `⚡${Math.round(w.tps!)} tok/s` }
      if (w.avgTps) {
        return { v: 0, text: `${w.state === 'running' ? '~' : 'avg '}${Math.round(w.avgTps)} tok/s` }
      }
      return undefined
    }
    const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

    const BORDER = { running: '', done: '#50fa7b', failed: '#ff5555', killed: '#6272a4' } as const
    // The face: finished states first, then a one-shot reaction, then idle, then a pose for what the agent is doing.
    const IDLE_MS = 10_000
    const faceOf = (w: { state: string; act?: string; lastAt?: number; react?: { kind: keyof typeof REACT_MS; at: number } }, f: number) => {
      if (w.state === 'done') return { eyes: '^ ^', mouth: '‿' }
      if (w.state === 'failed') return { eyes: 'x x', mouth: '~' }
      if (w.state === 'killed') return { eyes: '- -', mouth: f % 8 < 4 ? 'z' : 'Z' }
      const r = w.react && now - w.react.at < REACT_MS[w.react.kind] ? w.react.kind : undefined
      if (r === 'error') return { eyes: '> <', mouth: '~', tint: '#ff5555' }
      if (r === 'write') return { eyes: '^ ^', mouth: '‿', tint: '#50fa7b' }
      if (r === 'turn') return { eyes: '_ _', mouth: '·' }
      if (w.lastAt && now - w.lastAt > IDLE_MS) return { eyes: f % 12 < 2 ? '– –' : '◔ ◔', mouth: '·' }
      if (f % 14 === 13) return { eyes: '– –', mouth: '·' }
      switch (w.act) {
        case 'read':
          return { eyes: ['◖ ◖', '◖ ◖', '● ●', '◗ ◗', '◗ ◗', '● ●'][f % 6]!, mouth: '·' }
        case 'edit':
          return { eyes: '▪ ▪', mouth: (f >> 1) % 2 ? '›' : '‹' }
        case 'bash':
          return { eyes: '◉ ◉', mouth: (f >> 1) % 2 ? 'O' : 'o' }
        case 'think':
          return { eyes: '◔ ◔', mouth: f % 8 < 4 ? '·' : '~' }
        default: {
          const eye = ['◐', '◓', '◑', '◒'][f % 4]!
          return { eyes: `${eye} ${eye}`, mouth: ['·', 'o', 'O', 'o'][f % 4]! }
        }
      }
    }

    // Beside the face: an agent-type badge on top, and a live status glyph under it.
    const ACCESSORY: Record<string, string> = { explore: '⌕', review: '✎', dev: '⚒' }
    const statusGlyph = (w: { state: string; act?: string; lastAt?: number; react?: { kind: keyof typeof REACT_MS; at: number } }, f: number) => {
      if (w.state !== 'running') return { g: '', color: undefined as string | undefined }
      const r = w.react && now - w.react.at < REACT_MS[w.react.kind] ? w.react.kind : undefined
      if (r === 'error') return { g: '!', color: '#ff5555' }
      if (r === 'write') return { g: '✓', color: '#50fa7b' }
      if (w.lastAt && now - w.lastAt > IDLE_MS) return { g: 'z', color: undefined }
      switch (w.act) {
        case 'read': return { g: '≡', color: undefined }
        case 'edit': return { g: (f >> 1) % 2 ? '▌' : '', color: undefined }
        case 'bash': return { g: (f >> 1) % 2 ? '$' : '', color: undefined }
        case 'think': return { g: ['·', '··', '···', '··'][(f >> 1) % 4]!, color: undefined }
        default: return { g: '', color: undefined }
      }
    }

    const bar = (w: { state: string }, f: number) => {
      const W = 12
      if (w.state === 'done') return '▰'.repeat(W)
      if (w.state === 'failed') return '▰'.repeat(W - 4) + '▱'.repeat(4)
      if (w.state === 'killed') return '▱'.repeat(W)
      const span = W - 3
      const p = f % (2 * span)
      const pos = p < span ? p : 2 * span - p
      return Array.from({ length: W }, (_, i) => (i >= pos && i < pos + 3 ? '▰' : '▱')).join('')
    }

    const running = list.filter(w => w.state === 'running').length
    const done = list.filter(w => w.state === 'done').length
    const failed = list.filter(w => w.state === 'failed').length
    const tokens = list.reduce((n, w) => n + w.tokens, 0)
    const liveTps = Math.round(list.reduce((n, w) => n + (w.state === 'running' ? (rateOf(w)?.v ?? 0) : 0), 0))

    const sorted = [...list].sort((a, b) =>
      a.state === 'running' !== (b.state === 'running') ? (a.state === 'running' ? -1 : 1) : b.startedAt - a.startedAt,
    )
    const fit = Math.max(1, Math.floor((rows - 6) / 5))
    const shown = sorted.slice(0, fit)

    const Avatar = ({ w, f }: { w: (typeof list)[number]; f: number }) => {
      const sp = SPECIES[num(w.id) % SPECIES.length]!
      const { eyes, mouth, tint } = faceOf(w, f) as { eyes: string; mouth: string; tint?: string }
      const color = tint ?? (w.state === 'failed' ? '#ff5555' : w.state === 'killed' ? '#6272a4' : sp.color)
      const badge = ACCESSORY[w.agent ?? ''] ?? ''
      const st = statusGlyph(w, f)
      return (
        <Box flexDirection="row" flexShrink={0}>
          <Box flexDirection="column" width={5} flexShrink={0}>
            {sp.rows(eyes, mouth).map(r => (
              <Text color={color} bold={w.state === 'running'}>{r}</Text>
            ))}
          </Box>
          <Box flexDirection="column" width={3} flexShrink={0}>
            <Text color={sp.color} dimColor={w.state !== 'running'}> {badge}</Text>
            <Text color={st.color ?? sp.color}> {st.g}</Text>
            <Text> </Text>
          </Box>
        </Box>
      )
    }

    const Card = ({ w }: { w: (typeof list)[number] }) => {
      const f = frame + num(w.id) * 3
      const sp = SPECIES[num(w.id) % SPECIES.length]!
      const accent = BORDER[w.state] || sp.color
      const elapsedMs = (w.endedAt ?? now) - w.startedAt
      const spin = SPIN[f % SPIN.length]!
      const badge =
        w.state === 'running'
          ? `${spin} ${mmss(elapsedMs)}`
          : w.state === 'done'
            ? `✔ ${mmss(elapsedMs)}`
            : w.state === 'failed'
              ? `✖ failed ${mmss(elapsedMs)}`
              : `■ stopped ${mmss(elapsedMs)}`
      const badgeColor = w.state === 'running' ? sp.color : w.state === 'done' ? '#50fa7b' : w.state === 'failed' ? '#ff5555' : '#6272a4'
      const activity =
        w.state === 'running'
          ? w.last
          : w.state === 'done'
            ? (w.note ?? 'finished')
            : w.state === 'failed'
              ? (w.err ?? w.last)
              : w.last
      const rate = rateOf(w)
      const spark = sparkOf(w.spark)
      const stats = [
        rate ? `${rate.text}${spark ? ` ${spark}` : ''}` : undefined,
        `${w.files} file${w.files === 1 ? '' : 's'}`,
        w.tokens ? `${kilo(w.tokens)} tok` : undefined,
        money(w.cost ?? 0),
        w.errors ? `${w.errors} err` : undefined,
        w.agent,
        w.model,
      ]
        .filter(Boolean)
        .join(' · ')
      return (
        <Box borderStyle="round" borderColor={accent} paddingX={1} gap={1} flexDirection="row">
          <Avatar w={w} f={f} />
          <Box flexDirection="column" flexGrow={1}>
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text bold color={sp.color}>{w.id} </Text>
                <Text bold>{w.title}</Text>
              </Text>
              <Text color={badgeColor} bold>{badge}</Text>
            </Box>
            <Text dimColor={w.state !== 'running'} wrap="truncate-end">{activity}</Text>
            <Text wrap="truncate-end">
              <Text color={badgeColor}>{bar(w, f)}</Text>
              <Text dimColor>  {stats}</Text>
            </Text>
          </Box>
        </Box>
      )
    }

    const rule = '─'.repeat(Math.max(8, cols - 2))
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="#bd93f9">◆ conductor</Text>
          <Text dimColor>
            {running} running · {done} done{failed ? ` · ${failed} failed` : ''}{liveTps ? ` · ⚡ ${liveTps} tok/s` : ''} · {money(ledger.cost)}
          </Text>
        </Box>
        <Text dimColor>{rule}</Text>
        {list.length === 0 && (
          <Box gap={2} marginTop={1}>
            <Avatar w={{ id: 'w0', state: 'killed', title: '', startedAt: 0, last: '', files: 0, tokens: 0, errors: 0 }} f={frame} />
            <Box flexDirection="column">
              <Text bold>No workers yet</Text>
              <Text dimColor>Ask Claude to omp_spawn some and they will show up here.</Text>
            </Box>
          </Box>
        )}
        {shown.map(w => (
          <Card w={w} />
        ))}
        {sorted.length > shown.length && <Text dimColor>  +{sorted.length - shown.length} more (enlarge the pane)</Text>}
        <Text dimColor>{rule}</Text>
        <Text bold>session total {money(ledger.cost)}<Text dimColor> · {ledger.spawned} worker{ledger.spawned === 1 ? '' : 's'} spawned · {kilo(ledger.tokens)} tok · {thinkingNow} reasoning · {modelNow.split('/').slice(1).join('/') || modelNow}</Text></Text>
      </Box>
    )
  })
}
