import { expect, test } from 'claude-code/testing'

import type { Handoff, Live, Preflight } from '../types'
import { cacheState, measureContext, parseAnalysis, projectAtReset } from '../hooks/brain'
import { costOf, estimateTurn, ratesFor } from '../hooks/pricing'
import { latestTtl, parseTranscript, summarize } from '../hooks/scan'
import { coldDur } from '../hooks/fmt'
import { DEFAULT_PREFS, EMPTY_LIVE } from '../hooks/state'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const HOUR = 3_600_000

const LIVE: Live = {
  ...EMPTY_LIVE,
  model: 'claude-opus-5-5',
  effort: 'medium',
  contextTokens: 84_000,
  contextWindow: 1_000_000,
  contextPercent: 8,
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    { kind: 'seven_day', percentUsed: 41 },
  ],
  lastRefreshAt: NOW - 60_000,
  ttlMs: HOUR,
  ttlLabel: '1h',
  ttlSource: 'detected',
  ownUsd: 2.5,
  sessionUsd: 2.4,
  steps: 40,
}

const PREFLIGHT: Preflight = {
  id: 1,
  text: 'fix the login bug',
  status: 'ready',
  effort: 'high',
  effortReason: 'Debugging with an unknown cause across files.',
  plan: ['Read the auth code', 'Reproduce', 'Fix and test'],
  improved: 'Find and fix why login fails after a password reset; add a test.',
  questions: ['Which environment shows it?'],
  savings: 'Name the auth file.',
  base: { context: 84_000, steps: 8, output: 4_000, isCold: false, model: 'claude-opus-5-5' },
  chosenEffort: 'keep',
  helperUsd: 0.0004,
}

const HANDOFF: Handoff = { status: 'ready', text: '# Handoff: login\n## Goal\nFix login.', at: NOW, usd: 0.03 }

const SHAPES: Record<string, string> = {
  live: 'live-1',
  history: 'history-1',
  preflight: 'preflight-1',
  handoff: 'handoff-1',
  prefs: 'prefs-1',
  turnCosts: 'turns-1',
  bloat: 'bloat-1',
}

/** Answers `$.state.get` as a session holding these values would. */
function seed(values: Record<string, unknown>) {
  return (_: unknown, e: { key: string }) => {
    const shape = SHAPES[e.key]
    if (!(e.key in values)) return { value: { value: undefined, version: 0 } }
    const value = values[e.key]

    return { value: { value: shape ? { shape, value } : value, version: 1 } }
  }
}

const BAND = {
  plugin: 'token-saver',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

const pane = (requestId: string) =>
  ({
    plugin: 'token-saver',
    component: 'Pane',
    requestId,
    props: {
      title: requestId,
      isFocused: false,
      bodyColumns: 100,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  }) as const

test('prices a request at API list rates', async () => {
  const usage = {
    input_tokens: 1_000,
    output_tokens: 2_000,
    cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: 10_000,
  }
  // Opus 5.5: $4 in, $20 out, $0.20 read, $5 write (5m), $8 write (1h) per MTok.
  expect(Math.abs(costOf(usage, 'claude-opus-5-5') - 0.114) < 1e-9).toBe(true)
  expect(Math.abs(costOf(usage, 'claude-opus-5-5', '1h') - 0.144) < 1e-9).toBe(true)
  expect(ratesFor('claude-sonnet-5-5').rates.read).toBe(0.1)
  expect(ratesFor('opus').isGuess).toBe(true)
  const est = estimateTurn({ context: 50_000, steps: 4, output: 2_000, isCold: false, model: 'claude-opus-5-5' }, 'medium', '5m')
  expect(est.steps).toBe(4)
  expect(est.usd).toBeGreaterThan(0)
})

test('reads a helper answer, fenced or not', async () => {
  const a = parseAnalysis('```json\n{"effort":"HIGH","plan":["a","b"],"steps":7,"improved":"Do X."}\n```')
  expect(a?.effort).toBe('high')
  expect(a?.plan?.length).toBe(2)
  expect(a?.steps).toBe(7)
  expect(parseAnalysis('no json here')).toBe(undefined)
})

test('counts each response once and folds it by day and model', async () => {
  const line = (id: string, t: number, out: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(t).toISOString(),
      requestId: `req_${id}`,
      sessionId: 's1',
      cwd: '/work/app',
      message: {
        id: `msg_${id}`,
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 10,
          output_tokens: out,
          cache_read_input_tokens: 1_000,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 },
        },
      },
    })
  // The same response written as two lines (one per content block) counts once.
  const text = [line('a', NOW - HOUR, 100), line('a', NOW - HOUR, 100), line('b', NOW - 2 * HOUR, 50)].join('\n')
  const agg = parseTranscript(text, text.length, NOW)
  const hist = summarize({ v: 1, files: { '/p/s1.jsonl': agg } }, NOW, LIVE.rateLimits, 1)
  expect(hist.total.req).toBe(2)
  expect(hist.total.output).toBe(150)
  expect(hist.models[0]?.label).toBe('Opus 5.5')
  expect(hist.ttl1hShare).toBe(1)
  expect(hist.projects[0]?.label).toBe('app')
})

test('the band shows the limits and its buttons, on every surface', async ($, on) => {
  on('state.get', seed({ live: LIVE, prefs: DEFAULT_PREFS, now: NOW, history: null }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^23%$/ }))?.text).toBe('23%')
    expect((await ui.find({ type: 'Text', text: /hot/ }))?.text).toBe('● hot 59m')
    expect((await ui.find({ key: 'band-stats' }))?.type).toBe('Button')
    await ui.unmount()
  }
})

test('the stats pane draws the limits and the context', async ($, on) => {
  on('state.get', seed({ live: LIVE, prefs: DEFAULT_PREFS, now: NOW, tab: 'now', scanning: '', history: null }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('token-saver-stats'), surface })
    expect((await ui.find({ text: /5-hour limit 23% used · 77% left/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Cache hot/ }))?.type).toBe('Text')
    expect((await ui.find({ key: 'tab-days' }))?.type).toBe('Button')
    await ui.unmount()
  }
})

test('the preflight pane offers the improved prompt and an estimate', async ($, on) => {
  on('state.get', seed({ live: LIVE, preflight: PREFLIGHT, now: NOW }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane('token-saver-preflight'), surface })
    expect((await ui.find({ type: 'Text', text: /^HIGH$/ }))?.text).toBe('HIGH')
    expect((await ui.find({ type: 'Text', text: /Estimated cost at medium/ }))?.type).toBe('Text')
    expect((await ui.find({ key: 'pf-send-improved' }))?.type).toBe('Button')
    expect((await ui.find({ key: 'pf-effort' }))?.type).toBe('Select')
    await ui.unmount()
  }
})

test('the handoff pane shows the document and its actions', async ($, on) => {
  on('state.get', seed({ handoff: HANDOFF }))

  const ui = await $.ui.mount({ ...pane('token-saver-handoff'), surface: 'desktop' })
  expect((await ui.find({ key: 'ho-fresh' }))?.type).toBe('Button')
  expect((await ui.find({ type: 'Markdown' }))?.type).toBe('Markdown')
  await ui.unmount()
})

test('forecasts where a window ends at its average pace', async () => {
  // Two of five hours gone at 20% used: 50% by the reset.
  const w = { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(NOW + 3 * HOUR).toISOString() }
  expect(Math.round(projectAtReset(w, NOW) ?? 0)).toBe(50)
  // Too early to say a minute into the window.
  expect(projectAtReset({ ...w, resetsAt: new Date(NOW + 5 * HOUR - 60_000).toISOString() }, NOW)).toBe(undefined)
})

test('measures what fills the context, largest first', async () => {
  const rows = [
    { role: 'user', text: 'x'.repeat(360), toolUses: [] },
    {
      role: 'assistant',
      text: 'ok',
      toolUses: [
        { tool: 'Read', input: { file_path: String.raw`C:\work\src\big.ts` }, text: 'y'.repeat(36_000) },
        { tool: 'Bash', input: { command: 'npm test' }, text: 'z'.repeat(3_600) },
      ],
    },
  ]
  const b = measureContext(rows, NOW)
  expect(b.kinds[0]?.kind).toBe('Read results')
  expect(b.items[0]?.label).toBe('Read src/big.ts')
  expect(b.items[0]?.tokens).toBe(10_000)
})

test('the turn row shows what the turn cost', async ($, on) => {
  on('state.get', seed({ turnCosts: [{ at: NOW, ms: 64_000, usd: 0.41, steps: 6, hit: 0.92 }] }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>Baked for 1m 4s</Text>
  })
  const base = { plugin: 'token-saver', component: 'TurnDuration', surface: 'desktop' } as const

  const ui = await $.ui.mount({ ...base, props: { word: 'Baked', durationMs: 64_300 } })
  expect((await ui.find({ type: 'Text', text: /req/ }))?.text).toBe('· ≈ $0.41 · 6 req · cache 92%')
  await ui.unmount()

  // A turn this mod has no record of keeps the engine's row alone.
  const other = await $.ui.mount({ ...base, props: { word: 'Baked', durationMs: 9_000 } })
  expect(await other.find({ type: 'Text', text: /req/ })).toBe(undefined)
  expect((await other.find({ type: 'Text' }))?.text).toBe('Baked for 1m 4s')
  await other.unmount()
})

test('the context tab breaks the chat down', async ($, on) => {
  const bloat = measureContext(
    [{ role: 'assistant', text: '', toolUses: [{ tool: 'Read', input: { file_path: '/a/b.ts' }, text: 'q'.repeat(36_000) }] }],
    NOW,
  )
  on('state.get', seed({ live: LIVE, prefs: DEFAULT_PREFS, now: NOW, tab: 'context', scanning: '', history: null, bloat }))

  const ui = await $.ui.mount({ ...pane('token-saver-stats'), surface: 'desktop' })
  expect((await ui.find({ text: /Read results/ })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'ctx-measure' }))?.type).toBe('Button')
  await ui.unmount()
})

test('the cache is hot, cooling near expiry, then cold', async () => {
  const at = (ago: number) => cacheState({ ...LIVE, lastRefreshAt: NOW - ago }, NOW)
  expect(at(60_000).isWarm).toBe(true)
  expect(at(60_000).isCooling).toBe(false)
  expect(at(55 * 60_000).isCooling).toBe(true)
  expect(at(61 * 60_000).isWarm).toBe(false)
  // While a turn runs, every request refreshes it.
  expect(cacheState({ ...LIVE, lastRefreshAt: NOW - 2 * HOUR, isTurnRunning: true }, NOW).isWarm).toBe(true)
})

test('the lifetime comes from the latest main-chat write, not subagents', async () => {
  const row = (hour: number, w5: number, w1: number) => [hour, 0, 1, 0, 0, 0, w5, w1, 0]
  const h = Math.floor(NOW / HOUR)
  const agg = (rows: number[][]) => ({ size: 1, mtimeMs: NOW, sessionId: 's', cwd: '/app', last: NOW, models: ['claude-opus-5-5'], rows })
  // Lots of 5m subagent writes, an older 5m main chat, the newest main chat on 1h.
  const hist = summarize(
    {
      v: 1,
      files: {
        '/p/s1/subagents/agent-a.jsonl': agg([row(h, 900_000, 0)]),
        '/p/old.jsonl': agg([row(h - 30, 50_000, 0)]),
        '/p/new.jsonl': agg([row(h - 1, 0, 40_000)]),
      },
    },
    NOW,
    LIVE.rateLimits,
    3,
  )
  expect(hist.ttl1hShare < 0.5).toBe(true)
  expect(hist.ttlRecent).toBe('1h')
  expect(latestTtl(agg([row(h - 2, 0, 10), row(h - 1, 10, 0)]))).toBe('5m')
})

test('the band says hot with the time left', async ($, on) => {
  on('state.get', seed({ live: LIVE, prefs: DEFAULT_PREFS, now: NOW, history: null }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /hot 59m/ })) !== undefined).toBe(true)
})

test('says how long the cache has been cold: minutes, then hours, then days', async () => {
  expect(coldDur(20_000)).toBe('just now')
  expect(coldDur(47 * 60_000)).toBe('47m')
  expect(coldDur(179 * 60_000)).toBe('179m')
  expect(coldDur(3 * HOUR)).toBe('3h')
  expect(coldDur(47 * HOUR)).toBe('47h')
  expect(coldDur(5 * 24 * HOUR)).toBe('5d')
})

test('the band shows a cold cache with its age and the re-cache cost', async ($, on) => {
  on('state.get', seed({ live: { ...LIVE, lastRefreshAt: NOW - 5 * HOUR }, prefs: DEFAULT_PREFS, now: NOW, history: null }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /cold/ }))?.text).toBe('○ cold 4h')
  expect((await ui.find({ type: 'Text', text: /next msg/ })) !== undefined).toBe(true)
})
