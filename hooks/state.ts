import type { Live, Prefs } from '../types'

export const EMPTY_LIVE: Live = {
  model: '',
  contextWindow: 0,
  rateLimits: [],
  samples: [],
  ownUsd: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  steps: 0,
  agentsUsd: 0,
  agentSteps: 0,
  lastRefreshAt: 0,
  ttlMs: 5 * 60_000,
  ttlLabel: '5m',
  ttlSource: 'default',
  isTurnRunning: false,
  turnStartedAt: 0,
  lastTurnEndAt: 0,
  warm: { pings: 0, usd: 0, lastAt: 0 },
}

export const DEFAULT_PREFS: Prefs = { keepWarm: false, preflight: 'prefix', showBand: true }
