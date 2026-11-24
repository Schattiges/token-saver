export type LimitWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** One reading of a rate-limit window, kept to work out the burn rate. */
export type LimitSample = { t: number; kind: string; pct: number; resetsAt?: string }

export type TokenCounts = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type TurnCost = TokenCounts & { usd: number; steps: number; ms: number }

export type CacheMiss = { at: number; tokens: number; extraUsd: number; idleMs: number }

export type WarmStats = { pings: number; usd: number; lastAt: number; note?: string }

export type Live = {
  model: string
  effort?: string
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: LimitWindow[]
  samples: LimitSample[]
  /** The engine's own session total, as /cost shows it. */
  sessionUsd?: number
  /** This mod's own count from every request it saw (main thread and subagents). */
  ownUsd: number
  tokens: TokenCounts
  steps: number
  agentsUsd: number
  agentSteps: number
  /** When the last main-thread request (or keep-warm ping) started: the cache's clock. */
  lastRefreshAt: number
  ttlMs: number
  ttlLabel: string
  ttlSource: string
  isTurnRunning: boolean
  turnStartedAt: number
  lastTurnEndAt: number
  lastTurn?: TurnCost
  lastMiss?: CacheMiss
  /** Every cold start this chat paid for: how many, and their extra cost over a cache read. */
  misses?: { count: number; usd: number }
  warm: WarmStats
  /** An effort picked in preflight, waiting for the turn of `pendingText`. */
  pendingEffort?: string
  pendingText?: string
  /** The effort this mod applies to the running turn's requests. */
  turnEffort?: string
}

export type Bucket = {
  req: number
  input: number
  output: number
  cacheRead: number
  write5m: number
  write1h: number
  usd: number
}

export type HistoryRow = Bucket & { key: string; label: string; last?: number }

export type History = {
  scannedAt: number
  files: number
  readFiles: number
  days: HistoryRow[]
  weeks: HistoryRow[]
  months: HistoryRow[]
  models: HistoryRow[]
  projects: HistoryRow[]
  sessions: HistoryRow[]
  hours: HistoryRow[]
  today: Bucket
  week: Bucket
  month: Bucket
  total: Bucket
  windows: Record<string, Bucket>
  ttl1hShare: number
  /** The lifetime the main chat's latest cache write used (subagents left out). */
  ttlRecent?: '1h' | '5m'
  /** `transcripts` (Claude Code's own files) or `ledger` (this mod's log, where there are none, as in Cowork). */
  source?: string
  error?: string
}

export type PreflightEstimate = {
  context: number
  steps: number
  output: number
  isCold: boolean
  model: string
}

export type Preflight = {
  id: number
  text: string
  status: 'thinking' | 'ready' | 'error'
  error?: string
  complexity?: string
  effort?: string
  effortReason?: string
  plan?: string[]
  improved?: string
  questions?: string[]
  savings?: string
  base?: PreflightEstimate
  chosenEffort: string
  helperUsd?: number
}

export type Handoff = {
  status: 'writing' | 'ready' | 'error'
  text?: string
  error?: string
  path?: string
  usd?: number
  at: number
}

/** One finished turn's cost, matched to its "Baked for …" row by duration. */
export type TurnTag = { at: number; ms: number; usd: number; steps: number; hit: number; effort?: string }

export type BloatItem = { label: string; tokens: number; kind: string }

/** What fills this chat's context, by kind and by single item. */
export type Bloat = {
  at: number
  total: number
  messages: number
  kinds: { kind: string; tokens: number; count: number }[]
  items: BloatItem[]
}

export type Prefs = {
  keepWarm: boolean
  preflight: string
  showBand: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'token-saver': {
      live: Shaped<Live>
      history: Shaped<History | null>
      preflight: Shaped<Preflight | null>
      handoff: Shaped<Handoff | null>
      prefs: Shaped<Prefs>
      turnCosts: Shaped<TurnTag[]>
      bloat: Shaped<Bloat | null>
      tab: string
      now: number
      scanning: string
    }
  }
}
