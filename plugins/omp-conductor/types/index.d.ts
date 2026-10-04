// What the worker is doing right now; drives the avatar's pose.
export type Act = 'think' | 'read' | 'edit' | 'bash' | 'tool'

export type WorkerView = {
  id: string
  title: string
  state: 'running' | 'done' | 'failed' | 'killed'
  startedAt: number
  endedAt?: number
  last: string
  files: number
  tokens: number
  cost: number
  errors: number
  model?: string
  agent?: string
  note?: string
  err?: string
  tps?: number
  tpsAt?: number
  avgTps?: number
  spark?: number[]
  act?: Act
  lastAt?: number
  react?: { kind: 'error' | 'write' | 'turn'; at: number }
}

declare module 'claude-code' {
  interface PluginState {
    'omp-conductor': { workers: WorkerView[]; frame: number; demo: boolean; model: string; ledger: { cost: number; tokens: number; spawned: number } }
  }
}
