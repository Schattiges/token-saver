import { atom, read, update } from 'claude-code'
import type { PromptSubmitAttachment, Register, RenderSurface, SessionMessage } from 'claude-code'

import type { Bloat, CacheMiss, Handoff, History, LimitWindow, Live, Preflight, Prefs, TurnTag } from '../types'
import {
  AUTO_LEVELS,
  cacheState,
  effortQuestion,
  measureContext,
  HANDOFF_PROMPT,
  KEEPALIVE_PROMPT,
  parseAnalysis,
  PREFLIGHT_SYSTEM,
  preflightPrompt,
  ttlOf,
} from './brain'
import { basename, dur, pct, shortDur, tok, usd, windowName, windowShort } from './fmt'
import { costOf, EFFORTS, ratesFor } from './pricing'
import { asCache, fitCache, parseTranscript, SCAN_KEY, summarize } from './scan'
import type { FileAgg, ScanCache } from './scan'
import { DEFAULT_PREFS, EMPTY_LIVE } from './state'
import { bandView, handoffView, preflightView, statsView } from './ui'

// Change a shape tag when that value's fields change: a value stored under an
// older tag then reads as the initial instead of meeting new code.
const liveAtom = atom({ plugin: 'token-saver', key: 'live' } as const, EMPTY_LIVE, { shape: 'live-1' })
const historyAtom = atom({ plugin: 'token-saver', key: 'history' } as const, null as History | null, {
  shape: 'history-1',
})
const preflightAtom = atom({ plugin: 'token-saver', key: 'preflight' } as const, null as Preflight | null, {
  shape: 'preflight-1',
})
const handoffAtom = atom({ plugin: 'token-saver', key: 'handoff' } as const, null as Handoff | null, {
  shape: 'handoff-1',
})
const prefsAtom = atom({ plugin: 'token-saver', key: 'prefs' } as const, DEFAULT_PREFS, { shape: 'prefs-1' })
const tabAtom = atom({ plugin: 'token-saver', key: 'tab' } as const, 'now')
const nowAtom = atom({ plugin: 'token-saver', key: 'now' } as const, 0)
const scanningAtom = atom({ plugin: 'token-saver', key: 'scanning' } as const, '')
const turnCostsAtom = atom({ plugin: 'token-saver', key: 'turnCosts' } as const, [] as TurnTag[], {
  shape: 'turns-1',
})
const bloatAtom = atom({ plugin: 'token-saver', key: 'bloat' } as const, null as Bloat | null, { shape: 'bloat-1' })

type Level = (typeof EFFORTS)[number]

const STATS = 'token-saver-stats'
const PREFLIGHT = 'token-saver-preflight'
const HANDOFF = 'token-saver-handoff'
// Prompts a person typed: at the terminal, in the desktop app (an SDK host) or by Remote Control.
const PERSON = new Set(['composer', 'sdk', 'bridge'])
const HOUR = 3_600_000
const LEDGER_KEY = 'ledger-v1'
const CONTINUE = 'Continue this work from the handoff a previous chat wrote:\n\n'

const COMMANDS = [
  { name: 'tokens', description: 'Token Saver: limits, cache timer, usage and cost stats, tips', immediate: true },
  {
    name: 'preflight',
    description: 'Check a prompt before sending it: effort, plan, cost and an improved version',
    argumentHint: '[prompt]',
  },
  {
    name: 'handoff',
    description: 'Write a handoff and continue in a fresh chat to save tokens',
    argumentHint: '[what to focus on]',
  },
  { name: 'handoff-load', description: "Put this project's latest handoff into the prompt" },
  {
    name: 'keepwarm',
    description: 'Keep the prompt cache warm while idle (on/off)',
    argumentHint: '[on|off]',
    immediate: true,
  },
] as const

type UsageRow = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** The work that outlives one dispatch, built in `session.start` over the session's engine. */
type Actions = {
  later(fn: () => Promise<unknown>): void
  runScan(): Promise<void>
  scheduleScan(): void
  ledgerAdd(usage: UsageRow, t: number): void
  measureContext(): Promise<void>
  tick(): Promise<void>
  startPreflight(text: string, files?: readonly PromptSubmitAttachment[]): Promise<void>
  retryPreflight(): Promise<void>
  preflightFromComposer(): Promise<void>
  sendPreflight(which: 'mine' | 'improved'): Promise<void>
  editPreflight(which: 'mine' | 'improved'): Promise<void>
  cancelPreflight(): Promise<void>
  startHandoff(focus?: string): Promise<void>
  continueFresh(surface: RenderSurface): Promise<void>
  copyHandoff(surface: RenderSurface): Promise<void>
  insertHandoff(): Promise<void>
  closeHandoff(): Promise<void>
  loadHandoff(): Promise<string>
  setPrefs(change: (p: Prefs) => Prefs): Promise<Prefs>
  openStats(): Promise<void>
}

export const register: Register = (on, options) => {
  const opt = {
    cacheTtl: String(options.cacheTtl ?? 'auto'),
    keepWarm: options.keepWarm === true,
    keepWarmMinutes: Math.max(0, Number(options.keepWarmMinutes ?? 60)),
    preflight: String(options.preflight ?? 'prefix'),
    helperModel: String(options.helperModel ?? 'haiku') || 'haiku',
    expensiveTurnUsd: Number(options.expensiveTurnUsd ?? 1),
    dailyBudgetUsd: Number(options.dailyBudgetUsd ?? 0),
    handoffAtPercent: Number(options.handoffAtPercent ?? 60),
    showBand: options.showBand !== false,
  }
  const helperModelId = opt.helperModel === 'haiku' ? 'claude-haiku-5-5' : opt.helperModel
  const prefsSnap = JSON.stringify({ k: opt.keepWarm, p: opt.preflight, b: opt.showBand })

  let act: Actions | undefined
  let lastTtlMs = 5 * 60_000
  let forks = 0
  let isTurnActive = false
  let bypassOnce = false
  let hasSuggestedHandoff = false
  let turn = { usd: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, startedAt: 0 }
  const alerted = new Set<string>()

  function withUsage(
    l: Live,
    context: { tokens?: number; window: number; percent?: number },
    limits: readonly LimitWindow[],
    sessionUsd: number | undefined,
    t: number,
  ): Live {
    const rateLimits = limits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    const samples = [
      ...l.samples,
      ...rateLimits.map(w => ({ t, kind: w.kind, pct: w.percentUsed, resetsAt: w.resetsAt })),
    ]
      .filter(s => s.t > t - 3 * HOUR)
      .slice(-150)

    return {
      ...l,
      contextTokens: context.tokens ?? l.contextTokens,
      contextWindow: context.window || l.contextWindow,
      contextPercent: context.percent ?? l.contextPercent,
      rateLimits,
      samples,
      sessionUsd: sessionUsd ?? l.sessionUsd,
    }
  }

  function ttlFrom(share: number | undefined): Pick<Live, 'ttlMs' | 'ttlLabel' | 'ttlSource'> {
    if (opt.cacheTtl === '5m' || opt.cacheTtl === '1h') {
      return { ttlMs: opt.cacheTtl === '1h' ? HOUR : 5 * 60_000, ttlLabel: opt.cacheTtl, ttlSource: 'from settings' }
    }
    if (share !== undefined && share > 0) {
      const is1h = share >= 0.5

      return { ttlMs: is1h ? HOUR : 5 * 60_000, ttlLabel: is1h ? '1h' : '5m', ttlSource: 'detected' }
    }

    return { ttlMs: 5 * 60_000, ttlLabel: '5m', ttlSource: 'assumed' }
  }

  // ============================================================ session

  on('session.start', async ($, e, next) => {
    for (const command of COMMANDS) await $.command.register(command)

    let isPinging = false
    let isScanning = false
    let isScanQueued = false
    let isScanScheduled = false
    let lastScanAt = 0
    let preflightSeq = 0
    let isLedgerDirty = false
    let budgetToastDay = ''
    const surface = await $.session.surface()
    // This mod's own log of every request it saw: the history where no transcripts exist (Cowork).
    const storedLedger = (await $.store.get(LEDGER_KEY)) as { models?: string[]; rows?: number[][] } | undefined
    const ledger = { models: storedLedger?.models ?? [], rows: storedLedger?.rows ?? [] }
    const attachments = new Map<number, readonly PromptSubmitAttachment[]>()

    const later = (fn: () => Promise<unknown>) => {
      $.clock.after(1, () => {
        fn().catch((err: unknown) => {
          $.ui.toast(`Token Saver: ${err instanceof Error ? err.message : String(err)}`)
        })
      })
    }

    const claudeDir = async () => {
      const configured = await $.env.get('CLAUDE_CONFIG_DIR')
      if (configured) return configured.replace(/\\/g, '/').replace(/\/$/, '')
      const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''

      return home.replace(/\\/g, '/').replace(/\/$/, '') + '/.claude'
    }

    type Found = { path: string; size: number; mtimeMs: number }
    const listJsonl = async (dir: string, depth: number, out: Found[]): Promise<void> => {
      let entries
      try {
        entries = await $.fs.list(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const path = `${dir}/${entry.name}`
        if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
          out.push({ path, size: entry.size, mtimeMs: entry.mtimeMs })
        } else if (entry.kind === 'dir' && depth > 0 && entry.name !== 'memory') {
          await listJsonl(path, depth - 1, out)
        }
      }
    }

    // ---------------------------------------------------------- history

    const runScan = async (): Promise<void> => {
      if (isScanning) {
        isScanQueued = true
        return
      }
      isScanning = true
      try {
        await update($, scanningAtom, () => 'Scanning transcripts…')
        const old = asCache(await $.store.get(SCAN_KEY))
        const found: Found[] = []
        await listJsonl(`${await claudeDir()}/projects`, 3, found)
        const isSame = (f: Found) => {
          const was = old.files[f.path]

          return was !== undefined && was.size === f.size && was.mtimeMs === f.mtimeMs
        }
        const changed = found.filter(f => !isSame(f)).length
        const cache: ScanCache = { v: 1, files: {} }
        let done = 0
        for (const f of found) {
          const was = old.files[f.path]
          if (was && isSame(f)) {
            cache.files[f.path] = was
            continue
          }
          try {
            cache.files[f.path] = parseTranscript(await $.fs.read(f.path), f.size, f.mtimeMs)
          } catch {
            if (was) cache.files[f.path] = was
          }
          done += 1
          if (done % 3 === 0) await update($, scanningAtom, () => `Reading ${done} of ${changed} changed transcripts…`)
        }
        const t = await $.clock.now()
        await $.store.set(SCAN_KEY, fitCache(cache, t))
        lastScanAt = t
        const l = await read($, liveAtom)
        const isLedger = found.length === 0
        const own: FileAgg = {
          size: 0,
          mtimeMs: 0,
          sessionId: 'token-saver-log',
          cwd: 'this app',
          last: t,
          models: ledger.models,
          rows: ledger.rows,
        }
        const view: ScanCache = isLedger ? { v: 1, files: { ledger: own } } : cache
        const hist = { ...summarize(view, t, l.rateLimits, changed), source: isLedger ? 'ledger' : 'transcripts' }
        const today = new Date(t).toDateString()
        if (opt.dailyBudgetUsd > 0 && hist.today.usd >= opt.dailyBudgetUsd && budgetToastDay !== today) {
          budgetToastDay = today
          $.ui.toast(`Daily budget reached: ${usd(hist.today.usd)} of ${usd(opt.dailyBudgetUsd)} today (API prices).`)
        }
        await update($, historyAtom, () => hist)
        await $.store.set('ttlShare', hist.ttl1hShare)
        await update($, liveAtom, x => ({ ...x, ...ttlFrom(hist.ttl1hShare) }))
      } finally {
        isScanning = false
        await update($, scanningAtom, () => '')
        if (isScanQueued) {
          isScanQueued = false
          later(runScan)
        }
      }
    }

    // ---------------------------------------------------------- keep-warm

    const keepWarm = async (t: number): Promise<void> => {
      const p = await read($, prefsAtom)
      if (!p.keepWarm || isPinging || isTurnActive) return
      const l = await read($, liveAtom)
      if (!l.lastRefreshAt || l.isTurnRunning) return
      const left = l.lastRefreshAt + l.ttlMs - t
      // Expired already: a ping would only pay to write it again.
      if (left <= 0) return
      const idleSince = Math.max(l.lastTurnEndAt, l.turnStartedAt)
      const stopped = 'stopped: idle past the keep-warm time'
      if (idleSince && t - idleSince > l.ttlMs + opt.keepWarmMinutes * 60_000) {
        if (l.warm.note !== stopped) await update($, liveAtom, x => ({ ...x, warm: { ...x.warm, note: stopped } }))
        return
      }
      const margin = l.ttlMs >= 30 * 60_000 ? 4 * 60_000 : 75_000
      if (left > margin || (l.contextTokens ?? 0) < 8_000) return

      isPinging = true
      forks += 1
      try {
        const started = await $.clock.now()
        const r = await $.model.fork({ prompt: KEEPALIVE_PROMPT })
        const usage = 'usage' in r ? r.usage : undefined
        const cost = usage ? costOf(usage, l.model, ttlOf(l)) : 0
        const isRead = usage ? usage.cache_read_input_tokens >= (l.contextTokens ?? 0) * 0.5 : false
        const note = r.isAnswered
          ? isRead
            ? undefined
            : 'the last ping found the cache gone'
          : `the last ping failed (${r.reason})`
        await update($, liveAtom, x => ({
          ...x,
          lastRefreshAt: isRead ? started : x.lastRefreshAt,
          ownUsd: x.ownUsd + cost,
          warm: { pings: x.warm.pings + 1, usd: x.warm.usd + cost, lastAt: started, note },
        }))
      } finally {
        forks -= 1
        isPinging = false
      }
    }

    const tick = async (): Promise<void> => {
      const t = await $.clock.now()
      await update($, nowAtom, () => t)
      await keepWarm(t)
      if (t - lastScanAt > 10 * 60_000) later(runScan)
      if (isLedgerDirty) {
        isLedgerDirty = false
        const cutoff = Math.floor((t - 400 * 24 * HOUR) / HOUR)
        ledger.rows = ledger.rows.filter(r => (r[0] ?? 0) >= cutoff)
        await $.store.set(LEDGER_KEY, ledger)
      }
      if (surface === 'terminal') {
        const l = await read($, liveAtom)
        const cache = cacheState(l, t)
        const limits = l.rateLimits.map(w => `${windowShort(w.kind)} ${pct(w.percentUsed)}`).join(' · ')
        const warm = cache.isWarm ? shortDur(cache.leftMs) : cache.hasCache ? 'cold' : '–'
        $.ui.status(`ctx ${pct(l.contextPercent)}${limits ? ' · ' + limits : ''} · cache ${warm} · ${usd(l.sessionUsd ?? l.ownUsd)}`)
      }
    }

    // After a turn: once things are quiet for a moment, pick up its usage.
    const scheduleScan = () => {
      if (isScanScheduled) return
      isScanScheduled = true
      $.clock.after(20_000, () => {
        isScanScheduled = false
        runScan().catch(() => undefined)
      })
    }

    // ---------------------------------------------------------- preflight

    const analyze = async (id: number, text: string): Promise<void> => {
      const l = await read($, liveAtom)
      const cache = cacheState(l, await $.clock.now())
      let recent: SessionMessage[] = []
      try {
        recent = await $.session.messages()
      } catch {
        // a fresh chat
      }
      const r = await $.model.complete({
        model: opt.helperModel,
        system: PREFLIGHT_SYSTEM,
        prompt: preflightPrompt(text, recent, l, cache.hasCache && !cache.isWarm),
        maxTokens: 2_000,
        effort: 'low',
        timeoutMs: 60_000,
      })
      const helperUsd = costOf(r.usage, helperModelId)
      await update($, liveAtom, x => ({ ...x, ownUsd: x.ownUsd + helperUsd }))
      const a = r.isAnswered ? parseAnalysis(r.text) : undefined
      if (!a) {
        const error = r.isAnswered
          ? 'the helper model did not answer in the expected form'
          : `the helper model call ended: ${r.reason}`
        await update($, preflightAtom, p => (p && p.id === id ? { ...p, status: 'error' as const, error, helperUsd } : p))
        return
      }
      const base = {
        context: (l.contextTokens ?? 20_000) + Math.ceil(text.length / 4),
        steps: a.steps ?? 3,
        output: a.outputTokens ?? 1_500,
        isCold: !cache.isWarm,
        model: l.model || 'claude-opus-5-5',
      }
      await update($, preflightAtom, p =>
        p && p.id === id
          ? {
              ...p,
              status: 'ready' as const,
              complexity: a.complexity,
              effort: a.effort,
              effortReason: a.effortReason,
              plan: a.plan,
              improved: a.improved && a.improved !== text.trim() ? a.improved : undefined,
              questions: a.questions,
              savings: a.savings,
              base,
              helperUsd,
            }
          : p,
      )
    }

    const startPreflight = async (text: string, files?: readonly PromptSubmitAttachment[]): Promise<void> => {
      const id = ++preflightSeq
      if (files?.length) attachments.set(id, files)
      await update($, preflightAtom, () => ({ id, text, status: 'thinking' as const, chosenEffort: 'keep' }))
      await $.ui.open({ id: PREFLIGHT, title: 'Preflight' })
      await analyze(id, text)
    }

    const pick = async (which: 'mine' | 'improved') => {
      const p = await read($, preflightAtom)
      if (!p) return undefined
      await update($, preflightAtom, () => null)
      await $.ui.close({ id: PREFLIGHT })

      return { p, text: which === 'improved' && p.improved ? p.improved : p.text }
    }

    // ---------------------------------------------------------- handoff

    const saveHandoff = async (text: string, t: number): Promise<string | undefined> => {
      const root = await claudeDir()
      const cwd = await $.session.cwd()
      const slug = basename(cwd).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'chat'
      const d = new Date(t)
      const p2 = (n: number) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
      await $.store.set(`handoff:${cwd}`, { text, at: t })
      await $.store.set('handoff:last', { text, at: t, cwd })
      for (const path of [`${root}/handoffs/${slug}-${stamp}.md`, `${root}/handoff-${slug}.md`]) {
        try {
          await $.fs.write(path, text)
          return path
        } catch {
          // the folder may not exist; try the next place
        }
      }

      return undefined
    }

    const startHandoff = async (focus = ''): Promise<void> => {
      const t = await $.clock.now()
      await update($, handoffAtom, () => ({ status: 'writing' as const, at: t }))
      await $.ui.open({ id: HANDOFF, title: 'Handoff' })
      const prompt = HANDOFF_PROMPT + (focus ? `\n\nFocus especially on: ${focus}` : '')
      forks += 1
      let r
      try {
        r = await $.model.fork({ prompt })
      } finally {
        forks -= 1
      }
      const l = await read($, liveAtom)
      let cost = 'usage' in r ? costOf(r.usage, l.model, ttlOf(l)) : 0
      let text = r.isAnswered ? r.text.trim() : ''
      if (!r.isAnswered && r.reason === 'nothing-to-fork') {
        await update($, handoffAtom, () => ({ status: 'error' as const, error: 'nothing to hand off yet: this chat has no reply', at: t }))
        return
      }
      if (!text) {
        // Fall back to the cheap model over the visible conversation.
        const rows = await $.session.messages()
        const transcript = rows
          .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text}`)
          .join('\n\n')
          .slice(-120_000)
        const c = await $.model.complete({
          model: opt.helperModel,
          system: HANDOFF_PROMPT,
          prompt: `The conversation so far:\n\n${transcript}`,
          maxTokens: 3_000,
          timeoutMs: 120_000,
        })
        cost += costOf(c.usage, helperModelId)
        text = c.isAnswered ? c.text.trim() : ''
        if (!text) {
          await update($, handoffAtom, () => ({ status: 'error' as const, error: c.isAnswered ? 'empty answer' : c.reason, at: t }))
          return
        }
      }
      await update($, liveAtom, x => ({ ...x, ownUsd: x.ownUsd + cost }))
      const path = await saveHandoff(text, t)
      await update($, handoffAtom, () => ({ status: 'ready' as const, text, path, usd: cost, at: t }))
    }

    // ---------------------------------------------------------- the rest

    const setPrefs = async (change: (p: Prefs) => Prefs): Promise<Prefs> => {
      const prefs = change(await read($, prefsAtom))
      await update($, prefsAtom, () => prefs)
      await $.store.set('prefs', { snap: prefsSnap, prefs })

      return prefs
    }

    act = {
      later,
      runScan,
      scheduleScan,
      ledgerAdd: (usage, t) => {
        const model = usage.model || 'unknown'
        let mi = ledger.models.indexOf(model)
        if (mi < 0) mi = ledger.models.push(model) - 1
        const hour = Math.floor(t / HOUR)
        let row = ledger.rows.find(r => r[0] === hour && r[1] === mi)
        if (!row) {
          row = [hour, mi, 0, 0, 0, 0, 0, 0, 0]
          ledger.rows.push(row)
        }
        const write = usage.cache_creation_input_tokens
        const is1h = opt.cacheTtl === '1h' || (opt.cacheTtl === 'auto' && lastTtlMs >= HOUR)
        row[2] = (row[2] ?? 0) + 1
        row[3] = (row[3] ?? 0) + usage.input_tokens
        row[4] = (row[4] ?? 0) + usage.output_tokens
        row[5] = (row[5] ?? 0) + usage.cache_read_input_tokens
        row[6] = (row[6] ?? 0) + (is1h ? 0 : write)
        row[7] = (row[7] ?? 0) + (is1h ? write : 0)
        row[8] = (row[8] ?? 0) + Math.round(costOf(usage, model, is1h ? '1h' : '5m') * 1e6)
        isLedgerDirty = true
      },
      measureContext: async () => {
        const rows = await $.session.messages()
        const bloat = measureContext(rows, await $.clock.now())
        await update($, bloatAtom, () => bloat)
      },
      tick,
      startPreflight,
      retryPreflight: async () => {
        const p = await read($, preflightAtom)
        if (!p) return
        await update($, preflightAtom, x => (x ? { ...x, status: 'thinking' as const, error: undefined } : x))
        await analyze(p.id, p.text)
      },
      preflightFromComposer: async () => {
        const box = await $.prompt.read()
        const text = box.text.trim()
        if (!text) {
          $.ui.toast('Type a prompt first, then press Preflight (or start it with ?? and press Enter).')
          return
        }
        await startPreflight(text)
      },
      sendPreflight: async which => {
        const got = await pick(which)
        if (!got) return
        const effort = got.p.chosenEffort !== 'keep' ? got.p.chosenEffort : undefined
        await update($, liveAtom, l => ({ ...l, pendingEffort: effort, pendingText: effort ? got.text : undefined }))
        const files = attachments.get(got.p.id)
        attachments.delete(got.p.id)
        bypassOnce = true
        await $.prompt.submit(files ? { text: got.text, attachments: files, asUser: true } : { text: got.text, asUser: true })
      },
      editPreflight: async which => {
        const got = await pick(which)
        if (!got) return
        bypassOnce = true
        await $.prompt.fill({ text: got.text, mode: 'replace' })
      },
      cancelPreflight: async () => {
        await update($, preflightAtom, () => null)
        await $.ui.close({ id: PREFLIGHT })
      },
      startHandoff,
      continueFresh: async surface => {
        const h = await read($, handoffAtom)
        if (!h?.text) return
        const body = CONTINUE + h.text
        await $.ui.close({ id: HANDOFF })
        try {
          await $.command.run({ command: 'clear' })
        } catch {
          await $.ui.copy({ text: body, surface })
          $.ui.toast('Could not clear this chat from here: the handoff is copied. Open a new chat and paste it.')
          return
        }
        bypassOnce = true
        await $.prompt.fill({ text: body, mode: 'replace' })
        $.ui.toast('Fresh context. The handoff is in the prompt: check it and press Enter.')
      },
      copyHandoff: async surface => {
        const h = await read($, handoffAtom)
        const r = await $.ui.copy({ text: h?.text ?? '', surface })
        $.ui.toast(r.isCopied ? 'Handoff copied.' : 'Could not copy here: use Put in prompt instead.')
      },
      insertHandoff: async () => {
        const h = await read($, handoffAtom)
        bypassOnce = true
        await $.prompt.fill({ text: CONTINUE + (h?.text ?? ''), mode: 'replace' })
      },
      closeHandoff: async () => {
        await $.ui.close({ id: HANDOFF })
      },
      loadHandoff: async () => {
        const cwd = await $.session.cwd()
        const mine = (await $.store.get(`handoff:${cwd}`)) as { text?: string } | undefined
        const last = (await $.store.get('handoff:last')) as { text?: string; cwd?: string } | undefined
        const text = mine?.text ?? last?.text
        if (!text) return 'No handoff saved yet. Run /handoff in the chat you want to continue.'
        bypassOnce = true
        await $.prompt.fill({ text: CONTINUE + text, mode: 'replace' })

        return mine?.text
          ? 'Put the latest handoff for this folder in the prompt.'
          : `Put the latest handoff (from ${basename(last?.cwd ?? '')}) in the prompt.`
      },
      setPrefs,
      openStats: async () => {
        await $.ui.open({ id: STATS, title: 'Token stats' })
        if ((await $.clock.now()) - lastScanAt > 60_000) later(runScan)
      },
    }

    // Toggles made in the panes win until the settings themselves change.
    const saved = (await $.store.get('prefs')) as { snap?: string; prefs?: Prefs } | undefined
    const prefs =
      saved?.snap === prefsSnap && saved.prefs
        ? saved.prefs
        : { keepWarm: opt.keepWarm, preflight: opt.preflight, showBand: opt.showBand }
    await update($, prefsAtom, () => prefs)
    await $.store.set('prefs', { snap: prefsSnap, prefs })

    const share = (await $.store.get('ttlShare')) as number | undefined
    const model = await $.session.model()
    const u = await $.session.usage()
    const t = await $.clock.now()
    await update($, liveAtom, l => ({ ...withUsage(l, u.context, u.rateLimits, u.cost?.usd, t), ...ttlFrom(share), model: l.model || model }))
    await update($, nowAtom, () => t)

    $.clock.every(15_000, () => {
      tick().catch(() => undefined)
    })
    $.clock.after(3_000, () => {
      runScan().catch(() => undefined)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      hasSuggestedHandoff = false
      await update($, liveAtom, l => ({
        ...EMPTY_LIVE,
        model: l.model,
        effort: l.effort,
        ttlMs: l.ttlMs,
        ttlLabel: l.ttlLabel,
        ttlSource: l.ttlSource,
        rateLimits: l.rateLimits,
        samples: l.samples,
      }))
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const t = await $.clock.now()
    const before = await read($, liveAtom)
    for (const w of e.rateLimits) {
      const old = before.rateLimits.find(x => x.kind === w.kind)
      if (old?.resetsAt && w.resetsAt && old.resetsAt !== w.resetsAt && w.percentUsed + 5 < old.percentUsed) {
        $.ui.toast(`${windowName(w.kind)} has reset: ${w.percentUsed}% used now.`)
      }
    }
    await update($, liveAtom, l => withUsage(l, e.context, e.rateLimits, e.cost?.usd, t))

    for (const w of e.rateLimits) {
      for (const level of [75, 90]) {
        const key = `${w.kind}:${w.resetsAt ?? ''}:${level}`
        if (w.percentUsed < level || alerted.has(key)) continue
        alerted.add(key)
        const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN
        $.ui.toast(
          `${windowName(w.kind)} at ${w.percentUsed}%` +
            (Number.isFinite(resets) ? `, resets in ${dur(resets - t)}.` : '.') +
            (level >= 90 ? ' Lower the effort or save big tasks for later.' : ''),
        )
      }
    }
    const percent = e.context.percent ?? 0
    if (!hasSuggestedHandoff && opt.handoffAtPercent > 0 && percent >= opt.handoffAtPercent) {
      hasSuggestedHandoff = true
      $.ui.toast(
        `Context is ${percent}% full: every request re-reads ${tok(e.context.tokens)} tokens. ` +
          'Press Handoff (or /handoff) to continue in a fresh chat.',
      )
    }

    return next(e)
  })

  // ============================================================ turns

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnActive = true
      const t = await $.clock.now()
      turn = { usd: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, startedAt: t }
      await update($, liveAtom, l => {
        const isPicked =
          l.pendingEffort !== undefined &&
          l.pendingText !== undefined &&
          (e.text.trim() === l.pendingText.trim() || e.text.includes(l.pendingText.slice(0, 60)))

        return {
          ...l,
          isTurnRunning: true,
          turnStartedAt: t,
          turnEffort: isPicked ? l.pendingEffort : undefined,
          pendingEffort: isPicked ? undefined : l.pendingEffort,
          pendingText: isPicked ? undefined : l.pendingText,
        }
      })
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    // A keep-warm ping or a handoff is counted where it is made.
    if (isMain && !isTurnActive && forks > 0) return yield* next(e)
    const started = await $.clock.now()
    const l = await read($, liveAtom)
    const level = EFFORTS.find(x => x === l.turnEffort)
    const input =
      isMain && level && typeof e.effort === 'string' && e.effort !== level ? { ...e, effort: level as Level } : e
    const result = yield* next(input)
    const usage = result.usage
    if (!usage) return result
    lastTtlMs = l.ttlMs
    act?.ledgerAdd(usage, started)

    let miss: CacheMiss | undefined
    await update($, liveAtom, x => {
      const ttl = ttlOf(x)
      const cost = costOf(usage, usage.model, ttl)
      const counted: Live = {
        ...x,
        ownUsd: x.ownUsd + cost,
        steps: x.steps + 1,
        tokens: {
          input: x.tokens.input + usage.input_tokens,
          output: x.tokens.output + usage.output_tokens,
          cacheRead: x.tokens.cacheRead + usage.cache_read_input_tokens,
          cacheWrite: x.tokens.cacheWrite + usage.cache_creation_input_tokens,
        },
      }
      if (!isMain) return { ...counted, agentsUsd: x.agentsUsd + cost, agentSteps: x.agentSteps + 1 }
      const written = usage.cache_creation_input_tokens
      if (x.lastRefreshAt > 0 && written > 20_000 && usage.cache_read_input_tokens < written) {
        const { rates } = ratesFor(usage.model)
        const write = ttl === '1h' ? rates.write1h : rates.write5m
        miss = {
          at: started,
          tokens: written,
          extraUsd: (written * (write - rates.read)) / 1e6,
          idleMs: started - x.lastRefreshAt,
        }
      }

      return {
        ...counted,
        model: usage.model || x.model,
        effort: typeof e.effort === 'string' ? e.effort : x.effort,
        lastRefreshAt: started,
        lastMiss: miss ?? x.lastMiss,
      }
    })
    if (isMain) {
      turn.usd += costOf(usage, usage.model, ttlOf(l))
      turn.steps += 1
      turn.input += usage.input_tokens
      turn.output += usage.output_tokens
      turn.cacheRead += usage.cache_read_input_tokens
      turn.cacheWrite += usage.cache_creation_input_tokens
    }
    const m = miss as CacheMiss | undefined
    if (m && m.extraUsd >= 0.05) {
      $.ui.toast(
        `Cache was cold${m.idleMs > l.ttlMs ? ` after ${dur(m.idleMs)} idle` : ''}: ` +
          `re-wrote ${tok(m.tokens)} tokens (≈ ${usd(m.extraUsd)} extra).`,
      )
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isTurnActive = false
    const t = await $.clock.now()
    const done = { ...turn, ms: e.durationMs || t - turn.startedAt }
    const applied = (await read($, liveAtom)).turnEffort
    if (done.steps > 0) {
      const prompt = done.cacheRead + done.input + done.cacheWrite
      const hit = prompt > 0 ? done.cacheRead / prompt : 0
      const tag: TurnTag = { at: t, ms: done.ms, usd: done.usd, steps: done.steps, hit, effort: applied }
      await update($, turnCostsAtom, list => [...list, tag].slice(-300))
    }
    await update($, liveAtom, l => ({
      ...l,
      isTurnRunning: false,
      lastTurnEndAt: t,
      turnEffort: undefined,
      warm: { ...l.warm, note: undefined },
      lastTurn: done.steps > 0 ? done : l.lastTurn,
    }))
    if (opt.expensiveTurnUsd > 0 && done.usd >= opt.expensiveTurnUsd) {
      $.ui.toast(`That turn cost ≈ ${usd(done.usd)} at API prices (${done.steps} requests, ${dur(done.ms)}).`)
    }
    act?.scheduleScan()

    return result
  })

  // ============================================================ prompts

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !PERSON.has(e.origin.kind)) return next(e)
    if (bypassOnce) {
      bypassOnce = false
      return next(e)
    }
    const prefs = await read($, prefsAtom)
    const text = e.text.trimStart()
    if (prefs.preflight === 'always' && text.startsWith('!!')) return next({ ...e, text: text.slice(2).trimStart() })
    const hasPrefix = text.startsWith('??')
    // An app's own event envelope (`<...>`) is no prompt a person typed.
    const isEnvelope = text.startsWith('<')
    const isWanted =
      prefs.preflight !== 'off' &&
      (hasPrefix || (prefs.preflight === 'always' && e.turnId === undefined && !isEnvelope))
    const prompt = hasPrefix ? text.slice(2).trim() : e.text.trim()
    if (prefs.preflight === 'auto' && !hasPrefix && e.turnId === undefined && !isEnvelope && prompt) {
      let level: string | undefined
      try {
        level = await Promise.race([
          $.model.classify(effortQuestion(prompt), AUTO_LEVELS, { model: opt.helperModel }),
          $.clock.sleep(5_000).then(() => undefined),
        ])
      } catch {
        level = undefined
      }
      const current = (await read($, liveAtom)).effort
      if (level && level !== current) {
        await update($, liveAtom, l => ({ ...l, pendingEffort: level, pendingText: e.text }))
        $.ui.toast(`Auto effort: ${level} for this prompt (session: ${current ?? 'default'}).`)
      }
      return next(e)
    }
    if (!isWanted || !prompt || !act) return next(e)
    const files = e.attachments
    act.later(() => act?.startPreflight(prompt, files) ?? Promise.resolve())

    return { drop: 'Preflight is checking this prompt: pick what to send in the Preflight pane.' }
  })

  // ============================================================ commands

  on('command.run', { command: 'tokens' }, async () => {
    act?.later(() => act?.openStats() ?? Promise.resolve())
    return { text: 'Opened Token stats.' }
  })

  on('command.run', { command: 'preflight' }, async ($, e) => {
    const text = e.args.trim()
    act?.later(() => (text ? act?.startPreflight(text) : act?.preflightFromComposer()) ?? Promise.resolve())
    return { text: 'Preflight opened.' }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const focus = e.args.trim()
    act?.later(() => act?.startHandoff(focus) ?? Promise.resolve())
    return { text: 'Writing a handoff in the Handoff pane.' }
  })

  on('command.run', { command: 'handoff-load' }, async () => {
    return { text: act ? await act.loadHandoff() : 'Token Saver is still starting.' }
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const prefs = await act?.setPrefs(p => ({
      ...p,
      keepWarm: arg === 'on' ? true : arg === 'off' ? false : !p.keepWarm,
    }))
    return { text: `Keep-warm ${prefs?.keepWarm ? 'on' : 'off'}.` }
  })

  // ============================================================ drawing

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const prefs = await read($, prefsAtom)
    if (!prefs.showBand || e.props.hasSurvey) return next(e)
    const [l, hist, t] = await Promise.all([read($, liveAtom), read($, historyAtom), read($, nowAtom)])

    return bandView($.ui.resolve(e), l, hist, t || Date.now(), e.props.bodyColumns, {
      preflight: () => act?.later(() => act?.preflightFromComposer() ?? Promise.resolve()),
      handoff: () => act?.later(() => act?.startHandoff() ?? Promise.resolve()),
      stats: () => act?.later(() => act?.openStats() ?? Promise.resolve()),
    })
  })

  on('ui.render', { component: 'Pane', requestId: STATS }, async ($, e) => {
    const [l, hist, tab, t, prefs, scanning] = await Promise.all([
      read($, liveAtom),
      read($, historyAtom),
      read($, tabAtom),
      read($, nowAtom),
      read($, prefsAtom),
      read($, scanningAtom),
    ])
    const bloat = await read($, bloatAtom)

    return statsView(
      $.ui.resolve(e),
      {
        live: l,
        hist,
        tab,
        now: t || Date.now(),
        prefs,
        scanning,
        dailyBudget: opt.dailyBudgetUsd,
        keepWarmMinutes: opt.keepWarmMinutes,
        bloat,
      },
      {
        setTab: key => {
          void update($, tabAtom, () => key)
          if (key === 'context') act?.later(() => act?.measureContext() ?? Promise.resolve())
        },
        measure: () => act?.later(() => act?.measureContext() ?? Promise.resolve()),
        rescan: () => act?.later(() => act?.runScan() ?? Promise.resolve()),
        toggleWarm: () => void act?.setPrefs(p => ({ ...p, keepWarm: !p.keepWarm })),
        cyclePreflight: () =>
          void act?.setPrefs(p => ({
            ...p,
            preflight: ({ prefix: 'always', always: 'auto', auto: 'off' } as Record<string, string>)[p.preflight] ?? 'prefix',
          })),
        handoff: () => act?.later(() => act?.startHandoff() ?? Promise.resolve()),
      },
    )
  })

  on('ui.render', { component: 'Pane', requestId: PREFLIGHT }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Text } = ui
    const [p, l, t] = await Promise.all([read($, preflightAtom), read($, liveAtom), read($, nowAtom)])
    if (!p) return <Text dimColor>No prompt to check. Type one and press Preflight, or start it with ?? and press Enter.</Text>

    return preflightView(ui, p, l, t || Date.now(), {
      send: which => act?.later(() => act?.sendPreflight(which) ?? Promise.resolve()),
      edit: which => act?.later(() => act?.editPreflight(which) ?? Promise.resolve()),
      setEffort: level => void update($, preflightAtom, x => (x ? { ...x, chosenEffort: level } : x)),
      cancel: () => act?.later(() => act?.cancelPreflight() ?? Promise.resolve()),
      retry: () => act?.later(() => act?.retryPreflight() ?? Promise.resolve()),
    })
  })

  on('ui.render', { component: 'Pane', requestId: HANDOFF }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Text } = ui
    const doc = await read($, handoffAtom)
    if (!doc) return <Text dimColor>No handoff yet. Press Handoff or run /handoff.</Text>
    const surface = e.surface

    return handoffView(ui, doc, {
      continueFresh: () => act?.later(() => act?.continueFresh(surface) ?? Promise.resolve()),
      copy: () => act?.later(() => act?.copyHandoff(surface) ?? Promise.resolve()),
      insert: () => act?.later(() => act?.insertHandoff() ?? Promise.resolve()),
      regenerate: () => act?.later(() => act?.startHandoff() ?? Promise.resolve()),
      close: () => act?.later(() => act?.closeHandoff() ?? Promise.resolve()),
    })
  })

  // A turn's cost beside its "Baked for 1m 4s" row, matched by the turn's duration.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.props.waitingFor) return next(e)
    const tags = await read($, turnCostsAtom)
    let best: TurnTag | undefined
    for (const tag of tags) {
      const gap = Math.abs(tag.ms - e.props.durationMs)
      if (gap <= 1_500 && (!best || gap < Math.abs(best.ms - e.props.durationMs))) best = tag
    }
    if (!best) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const row = await next(e)

    return (
      <Box flexDirection="row" columnGap={1}>
        {row}
        <Text dimColor>
          {`· ≈ ${usd(best.usd)} · ${best.steps} req · cache ${Math.round(best.hit * 100)}%` +
            (best.effort ? ` · ${best.effort}` : '')}
        </Text>
      </Box>
    )
  })
}
