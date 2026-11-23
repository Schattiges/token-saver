// Reads Claude Code's own transcripts (~/.claude/projects/**/*.jsonl) for the
// usage the API reported on every request, so history covers sessions from
// before this mod was installed. Files are re-read only when they changed.

import type { Bucket, History, HistoryRow } from '../types'
import {
  basename,
  dayKey,
  dayLabel,
  monthKey,
  monthLabel,
  weekKey,
  windowMs,
} from './fmt'
import { costOf, modelLabel } from './pricing'

/** One file's usage: hour rows of [hour, model, req, in, out, read, write5m, write1h, usd x 1e6]. */
export type FileAgg = {
  size: number
  mtimeMs: number
  sessionId: string
  cwd: string
  last: number
  models: string[]
  rows: number[][]
}

export type ScanCache = { v: 1; files: Record<string, FileAgg> }

const HOUR = 3_600_000
const DAY = 24 * HOUR
const STORE_LIMIT = 3_000_000

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  speed?: string
}

type Line = {
  type?: string
  timestamp?: string
  requestId?: string
  sessionId?: string
  cwd?: string
  message?: { id?: string; model?: string; usage?: Usage }
}

export function parseTranscript(text: string, size: number, mtimeMs: number): FileAgg {
  const seen = new Set<string>()
  const models: string[] = []
  const rows = new Map<string, number[]>()
  let sessionId = ''
  let cwd = ''
  let last = 0

  for (const raw of text.split('\n')) {
    if (!cwd && raw.includes('"cwd"')) {
      try {
        const line = JSON.parse(raw) as Line
        cwd = line.cwd ?? ''
        sessionId = sessionId || (line.sessionId ?? '')
      } catch {
        // a torn last line while the session writes it
      }
    }
    if (!raw.includes('"usage"') || !raw.includes('"assistant"')) continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    const message = line.message
    const usage = message?.usage
    const model = message?.model
    if (line.type !== 'assistant' || !usage || !model || model === '<synthetic>') continue
    // One response is written as several lines, one per content block.
    const id = `${message.id ?? ''}:${line.requestId ?? ''}`
    if (id !== ':') {
      if (seen.has(id)) continue
      seen.add(id)
    }
    const t = Date.parse(line.timestamp ?? '')
    if (!Number.isFinite(t)) continue
    sessionId = sessionId || (line.sessionId ?? '')
    last = Math.max(last, t)

    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const read = usage.cache_read_input_tokens ?? 0
    const written = usage.cache_creation_input_tokens ?? 0
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, written - write1h)
    const cost = costOf(
      {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: written,
        write5m,
        write1h,
        speed: usage.speed,
      },
      model,
    )

    let mi = models.indexOf(model)
    if (mi < 0) mi = models.push(model) - 1
    const hour = Math.floor(t / HOUR)
    const key = `${hour}:${mi}`
    const row = rows.get(key) ?? [hour, mi, 0, 0, 0, 0, 0, 0, 0]
    row[2] = (row[2] ?? 0) + 1
    row[3] = (row[3] ?? 0) + input
    row[4] = (row[4] ?? 0) + output
    row[5] = (row[5] ?? 0) + read
    row[6] = (row[6] ?? 0) + write5m
    row[7] = (row[7] ?? 0) + write1h
    row[8] = (row[8] ?? 0) + Math.round(cost * 1e6)
    rows.set(key, row)
  }

  return { size, mtimeMs, sessionId, cwd, last, models, rows: [...rows.values()] }
}

/** The cache lifetime a transcript's latest write used, if it made one. */
export function latestTtl(agg: FileAgg): '1h' | '5m' | undefined {
  let at = -1
  let out: '1h' | '5m' | undefined
  for (const r of agg.rows) {
    const w5 = r[6] ?? 0
    const w1 = r[7] ?? 0
    if (w5 + w1 === 0 || (r[0] ?? 0) < at) continue
    at = r[0] ?? 0
    out = w1 > 0 ? '1h' : '5m'
  }

  return out
}

export function asCache(stored: unknown): ScanCache {
  const c = stored as ScanCache | undefined

  return c?.v === 1 && c.files ? c : { v: 1, files: {} }
}

/** The store holds 4 MiB per plugin: drops the oldest hours until the cache fits. */
export function fitCache(cache: ScanCache, now: number): ScanCache {
  let keepDays = 400
  while (JSON.stringify(cache).length > STORE_LIMIT && keepDays > 14) {
    const cutoff = Math.floor((now - keepDays * DAY) / HOUR)
    for (const agg of Object.values(cache.files)) {
      agg.rows = agg.rows.filter(r => (r[0] ?? 0) >= cutoff)
    }
    keepDays = Math.floor(keepDays / 2)
  }

  return cache
}

export const SCAN_KEY = 'scan-v1'

const emptyBucket = (): Bucket => ({
  req: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  write5m: 0,
  write1h: 0,
  usd: 0,
})

function add(b: Bucket, r: number[]): void {
  b.req += r[2] ?? 0
  b.input += r[3] ?? 0
  b.output += r[4] ?? 0
  b.cacheRead += r[5] ?? 0
  b.write5m += r[6] ?? 0
  b.write1h += r[7] ?? 0
  b.usd += (r[8] ?? 0) / 1e6
}

type Windows = { kind: string; resetsAt?: string }[]

/** Folds the per-file rows into the views the stats pane draws. */
export function summarize(cache: ScanCache, now: number, windows: Windows, read: number): History {
  const days = new Map<string, HistoryRow>()
  const weeks = new Map<string, HistoryRow>()
  const months = new Map<string, HistoryRow>()
  const models = new Map<string, HistoryRow>()
  const projects = new Map<string, HistoryRow>()
  const sessions = new Map<string, HistoryRow>()
  const hours = new Map<string, HistoryRow>()
  const total = emptyBucket()
  const today = emptyBucket()
  const week = emptyBucket()
  const month = emptyBucket()
  const todayKey = dayKey(now)
  const thisWeek = weekKey(now)
  const thisMonth = monthKey(now)
  const recent = now - 30 * DAY
  let w5 = 0
  let w1 = 0

  // Window starts: from the reset time where the API gave one, else rolling.
  const starts: Record<string, number> = {}
  const windowBuckets: Record<string, Bucket> = {}
  for (const w of windows) {
    const length = windowMs(w.kind)
    if (length === undefined) continue
    const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    starts[w.kind] = Number.isFinite(resets) ? resets - length : now - length
    windowBuckets[w.kind] = emptyBucket()
  }

  // Seed the last 14 days, 8 weeks and 6 months so empty ones still show.
  for (let i = 0; i < 14; i++) {
    const t = now - i * DAY
    days.set(dayKey(t), { ...emptyBucket(), key: dayKey(t), label: dayLabel(t) })
  }
  for (let i = 0; i < 8; i++) {
    const t = now - i * 7 * DAY
    const k = weekKey(t)
    weeks.set(k, { ...emptyBucket(), key: k, label: `Week of ${dayLabel(Date.parse(k + 'T12:00:00'))}` })
  }
  for (let i = 0; i < 6; i++) {
    const d = new Date(now)
    const t = new Date(d.getFullYear(), d.getMonth() - i, 15).getTime()
    months.set(monthKey(t), { ...emptyBucket(), key: monthKey(t), label: monthLabel(t) })
  }
  for (let i = 0; i < 24; i++) {
    const h = Math.floor(now / HOUR) - i
    hours.set(String(h), { ...emptyBucket(), key: String(h), label: String(new Date(h * HOUR).getHours()) })
  }

  // The cache lifetime the main chat uses now: its latest hour with a cache write.
  // Subagents write 5m caches even on a 1h plan, so they are left out.
  let ttlAt = -1
  let ttlRecent: '1h' | '5m' | undefined
  for (const [path, agg] of Object.entries(cache.files)) {
    if (/[\/]subagents[\/]/.test(path)) continue
    for (const r of agg.rows) {
      const w5r = r[6] ?? 0
      const w1r = r[7] ?? 0
      if (w5r + w1r === 0 || (r[0] ?? 0) < ttlAt) continue
      ttlAt = r[0] ?? 0
      ttlRecent = w1r > 0 ? '1h' : '5m'
    }
  }

  for (const [path, agg] of Object.entries(cache.files)) {
    const project = agg.cwd ? basename(agg.cwd) : basename(path.replace(/\/[^/]*$/, ''))
    for (const r of agg.rows) {
      const hour = r[0] ?? 0
      const t = hour * HOUR + HOUR / 2
      const model = agg.models[r[1] ?? 0] ?? 'unknown'
      add(total, r)
      const dk = dayKey(t)
      const day = days.get(dk)
      if (day) add(day, r)
      const wk = weeks.get(weekKey(t))
      if (wk) add(wk, r)
      const mo = months.get(monthKey(t))
      if (mo) add(mo, r)
      const hr = hours.get(String(hour))
      if (hr) add(hr, r)
      if (dk === todayKey) add(today, r)
      if (weekKey(t) === thisWeek) add(week, r)
      if (monthKey(t) === thisMonth) add(month, r)
      for (const [kind, start] of Object.entries(starts)) {
        const b = windowBuckets[kind]
        if (b && (hour + 1) * HOUR > start) add(b, r)
      }
      if (t < recent) continue
      const label = modelLabel(model)
      const m = models.get(label) ?? { ...emptyBucket(), key: label, label }
      add(m, r)
      models.set(label, m)
      const p = projects.get(project) ?? { ...emptyBucket(), key: project, label: project }
      add(p, r)
      projects.set(project, p)
      const sk = agg.sessionId || path
      const s = sessions.get(sk) ?? {
        ...emptyBucket(),
        key: sk,
        label: `${project} · ${sk.slice(0, 8)}`,
        last: agg.last,
      }
      add(s, r)
      sessions.set(sk, s)
      if (t > now - 7 * DAY) {
        w5 += r[6] ?? 0
        w1 += r[7] ?? 0
      }
    }
  }

  const byKeyDesc = (a: HistoryRow, b: HistoryRow) => (a.key < b.key ? 1 : -1)
  const byUsd = (a: HistoryRow, b: HistoryRow) => b.usd - a.usd

  return {
    scannedAt: now,
    files: Object.keys(cache.files).length,
    readFiles: read,
    days: [...days.values()].sort(byKeyDesc),
    weeks: [...weeks.values()].sort(byKeyDesc),
    months: [...months.values()].sort(byKeyDesc),
    models: [...models.values()].sort(byUsd),
    projects: [...projects.values()].sort(byUsd).slice(0, 12),
    sessions: [...sessions.values()].sort(byUsd).slice(0, 12),
    hours: [...hours.values()].sort((a, b) => Number(a.key) - Number(b.key)),
    today,
    week,
    month,
    total,
    windows: windowBuckets,
    ttl1hShare: w5 + w1 > 0 ? w1 / (w5 + w1) : 0,
    ttlRecent,
  }
}
