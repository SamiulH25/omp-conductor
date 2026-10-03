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
  note?: string
  err?: string
  tps?: number
  tpsAt?: number
  avgTps?: number
  spark?: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'omp-conductor': { workers: WorkerView[]; frame: number; demo: boolean; model: string; ledger: { cost: number; tokens: number; spawned: number } }
  }
}
