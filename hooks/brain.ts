// The prompts this mod sends, how it reads their answers, and the advice it gives.

import type { Bloat, BloatItem, History, LimitSample, Live } from '../types'
import { coldDur, dur, pct, shortDur, tok, usd, windowName } from './fmt'
import { contextCost, ratesFor } from './pricing'

export const PREFLIGHT_SYSTEM = `You review a prompt a person is about to send to Claude Code, an agentic coding assistant that reads and edits files, runs shell commands, searches code and the web, and can start subagents.
Reply with ONLY one JSON object, no prose and no code fence, with exactly these fields:
{
  "complexity": "trivial | simple | moderate | complex | very complex",
  "effort": "low | medium | high | xhigh | max",
  "effortReason": "why, in at most 20 words",
  "plan": ["3 to 7 short steps Claude will most likely take, in order"],
  "steps": <integer 1-60: model requests the turn will take, about one per tool call plus one>,
  "outputTokens": <integer: tokens Claude will write at medium effort, thinking and code included>,
  "improved": "a clearer, more specific version of the prompt, in the SAME language as the original",
  "questions": ["0 to 3 ambiguities worth settling before sending"],
  "savings": "one concrete way to make this prompt cheaper, in at most 25 words, or an empty string"
}
Effort guide: low = a quick question, lookup, rename or one-line edit; medium = a normal single-file change or an explanation; high = a multi-file feature or debugging with an unknown cause; xhigh = a large refactor or hard algorithmic or architectural work; max = only when correctness is critical and cost does not matter.
For "improved": keep the person's intent and voice; add the scope, the files or places to look, constraints, what done looks like and how to verify it, where those are missing or implied by the conversation; remove filler; never invent facts or requirements. If the prompt is already clear, return it nearly unchanged.`

export type Analysis = {
  complexity?: string
  effort?: string
  effortReason?: string
  plan?: string[]
  steps?: number
  outputTokens?: number
  improved?: string
  questions?: string[]
  savings?: string
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export function parseAnalysis(text: string): Analysis | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined
  const effort = str(raw.effort)?.toLowerCase()

  return {
    complexity: str(raw.complexity),
    effort: effort && LEVELS.includes(effort) ? effort : undefined,
    effortReason: str(raw.effortReason),
    plan: list(raw.plan)?.slice(0, 8),
    steps: num(raw.steps, 1, 80),
    outputTokens: num(raw.outputTokens, 50, 200_000),
    improved: str(raw.improved),
    questions: list(raw.questions)?.slice(0, 3),
    savings: str(raw.savings),
  }
}

type Message = { role: string; text: string; toolUses: readonly { tool: string }[] }

export function preflightPrompt(
  text: string,
  recent: readonly Message[],
  live: Live,
  isCold: boolean,
): string {
  const lines = recent
    .filter(m => m.text.trim() !== '' || m.toolUses.length > 0)
    .slice(-8)
    .map(m => {
      const body = m.text.replace(/\s+/g, ' ').trim().slice(0, 700)
      const tools = m.toolUses.map(t => t.tool).slice(0, 8)

      return `${m.role === 'user' ? 'User' : 'Claude'}: ${body}${tools.length ? ` [tools: ${tools.join(', ')}]` : ''}`
    })

  return [
    `Session: model ${live.model || 'unknown'}, effort ${live.effort ?? 'default'}, ` +
      `context ${live.contextTokens ?? 'unknown'} tokens, prompt cache ${isCold ? 'cold' : 'warm'}.`,
    lines.length
      ? `Recent conversation (oldest first, shortened):\n${lines.join('\n')}`
      : 'This is the first prompt of a new chat.',
    `The prompt to review:\n<<<\n${text}\n>>>`,
  ].join('\n\n')
}

export const HANDOFF_PROMPT = `Write a HANDOFF document so this work can continue in a brand-new chat that cannot see this conversation. Do not use tools. Be dense and concrete, 300 to 700 words, in Markdown, in the language the user writes in.
Use these sections:
# Handoff: <short title>
## Goal: what the user ultimately wants, in their words where possible
## Current state: what is done and verified, what is half done
## Decisions and constraints: choices made and why, the user's preferences, things NOT to do
## Files and places: paths that matter, one line each
## Commands: how to build, run and test, where known
## Next steps: numbered, most important first
## Gotchas: errors hit and how they were solved
Write only the document.`

export const KEEPALIVE_PROMPT =
  'Automated prompt-cache keep-alive, not a message from the user. Do not use tools and do not think about it. Reply with exactly: ok'

/** Percentage points per hour over the last 90 minutes of one window, when it moved. */
export function burnRate(samples: readonly LimitSample[], kind: string, now: number): number | undefined {
  const mine = samples.filter(s => s.kind === kind && s.t > now - 90 * 60_000)
  const last = mine[mine.length - 1]
  if (!last) return undefined
  const same = mine.filter(s => s.resetsAt === last.resetsAt)
  const first = same[0]
  if (!first || last.t - first.t < 10 * 60_000) return undefined
  const rate = ((last.pct - first.pct) / (last.t - first.t)) * 3_600_000

  return rate > 0 ? rate : 0
}

export function ttlOf(live: Live): '5m' | '1h' {
  return live.ttlMs >= 30 * 60_000 ? '1h' : '5m'
}

/** How long before expiry the cache counts as cooling: 10 min of a 1h cache, 90 s of a 5m one. */
export function coolingMs(ttlMs: number): number {
  return ttlMs >= 30 * 60_000 ? 10 * 60_000 : 90_000
}

export function cacheState(
  live: Live,
  now: number,
): { isWarm: boolean; isCooling: boolean; leftMs: number; hasCache: boolean } {
  const hasCache = live.lastRefreshAt > 0
  // A running turn refreshes the cache with every request: it is hot throughout.
  const leftMs = !hasCache ? 0 : live.isTurnRunning ? live.ttlMs : live.lastRefreshAt + live.ttlMs - now
  const isWarm = hasCache && leftMs > 0

  return { isWarm, isCooling: isWarm && leftMs <= coolingMs(live.ttlMs), leftMs, hasCache }
}

export function tips(live: Live, hist: History | null, now: number): string[] {
  const out: string[] = []
  const ttl = ttlOf(live)
  const ctx = live.contextTokens ?? 0
  const { warm, cold } = contextCost(ctx, live.model, ttl)
  const cache = cacheState(live, now)

  if ((live.contextPercent ?? 0) >= 40) {
    out.push(
      `**Context is ${pct(live.contextPercent)} full** (${tok(ctx)} tokens). Every request re-reads all of it: ` +
        `about ${usd(warm)} per request while cached and ${usd(cold)} after a cold start. ` +
        `A /handoff to a fresh chat usually pays for itself within a few turns.`,
    )
  }
  if (cache.hasCache && !cache.isWarm && ctx > 20_000) {
    out.push(
      `**The cache has expired.** Your next message re-writes ${tok(ctx)} tokens (about ${usd(cold - warm)} extra). ` +
        `If you often pause longer than ${live.ttlLabel}, turn keep-warm on.`,
    )
  }
  for (const w of live.rateLimits) {
    const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    const left = Number.isFinite(resets) ? resets - now : undefined
    const rate = burnRate(live.samples, w.kind, now)
    if (rate && left !== undefined && rate > 0) {
      const eta = ((100 - w.percentUsed) / rate) * 3_600_000
      if (eta < left) {
        out.push(
          `**${windowName(w.kind)}: at this pace you hit 100% in ${dur(eta)}**, ${dur(left - eta)} before it resets. ` +
            `Lower the effort, use a cheaper model for routine steps, or pause.`,
        )
      }
    } else if (w.percentUsed >= 80) {
      out.push(`**${windowName(w.kind)} is at ${w.percentUsed}%.** Save the expensive work for after it resets.`)
    }
  }
  if (live.effort === 'xhigh' || live.effort === 'max') {
    out.push(
      `**Effort is ${live.effort}.** Questions, lookups and small edits do as well at medium or low and write far fewer thinking tokens. ` +
        `Start a prompt with ?? to have preflight suggest a level.`,
    )
  }
  if (live.agentsUsd > 0.5 && live.agentsUsd > live.ownUsd * 0.4) {
    out.push(
      `**Subagents cost ${usd(live.agentsUsd)}** of this session's ${usd(live.ownUsd)}. Each one starts its own context; ask for fewer, narrower ones.`,
    )
  }
  if (hist) {
    const w = hist.week
    const prompt = w.cacheRead + w.input + w.write5m + w.write1h
    const hit = prompt > 0 ? w.cacheRead / prompt : 1
    if (prompt > 1_000_000 && hit < 0.85) {
      out.push(
        `**Cache hit rate this week is ${Math.round(hit * 100)}%.** Cold starts re-write the context at ${ttl === '1h' ? '2x' : '1.25x'} the input price; ` +
          `fewer long pauses mid-task, or keep-warm, raise it.`,
      )
    }
    const top = hist.models[0]
    const all = hist.models.reduce((s, m) => s + m.usd, 0)
    if (top && all > 5 && top.usd / all > 0.85 && /Opus|Fable/.test(top.label)) {
      const cheaper = ratesFor('claude-sonnet-5-5').rates.output / ratesFor(top.label.toLowerCase().replace(/ /g, '-').replace('.', '-')).rates.output
      out.push(
        `**${Math.round((top.usd / all) * 100)}% of your 30-day spend is on ${top.label}.** Sonnet 5.5 costs about ${Math.round(cheaper * 100)}% as much per token for routine work. ` +
          `Switch at the start of a chat: switching mid-chat restarts the cache.`,
      )
    }
  }
  out.push(
    'Name the files, functions or error messages in your prompt: Claude then reads less to find them.',
    'For a big task, ask for a short plan first and approve it; a wrong direction costs whole turns.',
    '/compact keeps working in the same chat with a summary; /handoff writes a portable brief you can start a fresh chat from.',
  )

  return out
}

// ------------------------------------------------------------ pace

/**
 * Where a window ends up at its reset if use keeps its average pace so far:
 * the projected percent, or undefined too early in the window to say.
 */
export function projectAtReset(
  w: { kind: string; percentUsed: number; resetsAt?: string },
  now: number,
): number | undefined {
  const length = w.kind === 'five_hour' ? 5 * 3_600_000 : w.kind.startsWith('seven_day') ? 7 * 86_400_000 : 0
  const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  if (!length || !Number.isFinite(resets)) return undefined
  const elapsed = now - (resets - length)
  if (elapsed < length * 0.08 || elapsed <= 0) return undefined

  return (w.percentUsed / elapsed) * length
}

// ------------------------------------------------------------ auto effort

export const AUTO_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const

/** The text `$.model.classify` reads to pick an effort level for one prompt. */
export function effortQuestion(prompt: string): string {
  return [
    'A person sent this request to an agentic coding assistant. Which reasoning effort does it need?',
    'low: a quick question, a lookup, a rename, a one-line or obvious edit.',
    'medium: a normal single-file change, an explanation, a short script.',
    'high: a multi-file feature, debugging with an unknown cause, careful review.',
    'xhigh: a large refactor, hard algorithmic or architectural work.',
    '',
    `Request: ${prompt.slice(0, 4_000)}`,
  ].join('\n')
}

// ------------------------------------------------------------ what fills the context

type ToolUseLike = { tool: string; input: Record<string, unknown>; text?: string }
type RowLike = { role: string; text: string; toolUses: readonly ToolUseLike[] }

const CHARS_PER_TOKEN = 3.6

export function describeInput(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'notebook_path', 'url', 'pattern', 'command', 'query', 'description', 'prompt']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) {
      const s = v.replace(/\s+/g, ' ').trim()
      const short = key.endsWith('path') ? s.split(/[\\/]/).slice(-2).join('/') : s

      return short.length > 60 ? short.slice(0, 57) + '…' : short
    }
  }

  return ''
}

/** Estimates what the visible conversation holds, by kind and by its largest items. */
export function measureContext(rows: readonly RowLike[], now: number): Bloat {
  const kinds = new Map<string, { tokens: number; count: number }>()
  const items: BloatItem[] = []
  const add = (kind: string, chars: number, label?: string) => {
    const tokens = Math.round(chars / CHARS_PER_TOKEN)
    if (tokens <= 0) return
    const k = kinds.get(kind) ?? { tokens: 0, count: 0 }
    k.tokens += tokens
    k.count += 1
    kinds.set(kind, k)
    if (label !== undefined) items.push({ kind, tokens, label })
  }
  for (const row of rows) {
    if (row.role === 'user') add('Your messages', row.text.length)
    else add('Claude replies', row.text.length)
    for (const use of row.toolUses) {
      const label = `${use.tool}${describeInput(use.input) ? ' ' + describeInput(use.input) : ''}`
      add(`${use.tool} results`, use.text?.length ?? 0, label)
      add('Tool calls (inputs)', JSON.stringify(use.input ?? {}).length)
    }
  }
  const sorted = [...kinds.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.tokens - a.tokens)

  return {
    at: now,
    total: sorted.reduce((s, k) => s + k.tokens, 0),
    messages: rows.length,
    kinds: sorted.slice(0, 12),
    items: items.sort((a, b) => b.tokens - a.tokens).slice(0, 10),
  }
}

/** What reading from the cache saved this chat over sending those tokens uncached. */
export function cacheSavings(live: Live): number {
  const { rates } = ratesFor(live.model)

  return Math.max(0, (live.tokens.cacheRead * (rates.input - rates.read)) / 1e6)
}

/** The cache in one line, as /cache answers it. */
export function cacheLine(live: Live, now: number): string {
  const cache = cacheState(live, now)
  const ctx = live.contextTokens ?? 0
  const { warm, cold } = contextCost(ctx, live.model, ttlOf(live))
  const life = `${live.ttlLabel} lifetime, ${live.ttlSource}`
  const state = !cache.hasCache
    ? 'Cache: no request in this chat yet'
    : live.isTurnRunning
      ? `Cache hot: a turn is running (${life})`
      : cache.isWarm
        ? `Cache ${cache.isCooling ? 'cooling' : 'hot'}: ${shortDur(cache.leftMs)} left (${life})`
        : `Cache cold for ${coldDur(-cache.leftMs)}: the next message re-writes ${tok(ctx)} tokens, +${usd(cold - warm)} (${life})`
  const saved = cacheSavings(live)
  const misses = live.misses && live.misses.count > 0
    ? ` · ${live.misses.count} cold start${live.misses.count === 1 ? '' : 's'}, +${usd(live.misses.usd)}`
    : ''

  return `${state}${saved >= 0.01 ? ` · saved ${usd(saved)} so far` : ''}${misses}.`
}
