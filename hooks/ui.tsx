import type { ElementTable } from 'claude-code'

import type { Bloat, Handoff, History, HistoryRow, Live, Preflight, Prefs } from '../types'
import { burnRate, cacheState, projectAtReset, tips, ttlOf } from './brain'
import { clock, dur, pct, shortDur, tok, usd, windowName, windowShort, windowMs } from './fmt'
import { contextCost, EFFORTS, estimateTurn, modelLabel } from './pricing'

type UI = ElementTable

const levelColor = (p: number) => (p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success')

// ---------------------------------------------------------------- the band

export type BandActions = { preflight(): void; handoff(): void; stats(): void }

export function bandView(ui: UI, live: Live, hist: History | null, now: number, columns: number, act: BandActions) {
  const { Box, Text, Button } = ui
  const cache = cacheState(live, now)
  const isNarrow = columns < 90
  const limits = live.rateLimits.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day' || w.kind === 'spend_limit')

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
      <Text dimColor>ctx</Text>
      <Text color={levelColor(live.contextPercent ?? 0)}>{pct(live.contextPercent)}</Text>
      {limits.map(w => {
        const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN

        return (
          <Box key={`w-${w.kind}`} flexDirection="row" columnGap={1}>
            <Text dimColor>· {windowShort(w.kind)}</Text>
            <Text color={levelColor(w.percentUsed)}>{pct(w.percentUsed)}</Text>
            {!isNarrow && Number.isFinite(resets) && <Text dimColor>↻{shortDur(resets - now)}</Text>}
          </Box>
        )
      })}
      <Text dimColor>· cache</Text>
      {live.isTurnRunning && cache.hasCache ? (
        <Text color="success" bold>● hot</Text>
      ) : cache.isWarm ? (
        <Text color={cache.isCooling ? 'warning' : 'success'} bold>
          {`${cache.isCooling ? '◐ cooling' : '● hot'} ${shortDur(cache.leftMs)}`}
        </Text>
      ) : (
        <Text color={cache.hasCache ? 'error' : 'subtle'}>{cache.hasCache ? '○ cold' : '–'}</Text>
      )}
      {!isNarrow && cache.hasCache && <Text dimColor>{`/${live.ttlLabel}`}</Text>}
      {live.warm.pings > 0 && !isNarrow && <Text dimColor>(kept {live.warm.pings}x)</Text>}
      <Text dimColor>· session {usd(live.sessionUsd ?? live.ownUsd)}</Text>
      {hist && !isNarrow && <Text dimColor>· today {usd(hist.today.usd)}</Text>}
      <Button key="band-preflight" label="Preflight" plain onPress={() => act.preflight()} />
      <Button key="band-handoff" label="Handoff" plain onPress={() => act.handoff()} />
      <Button key="band-stats" label="Stats" plain onPress={() => act.stats()} />
    </Box>
  )
}

// ---------------------------------------------------------------- stats pane

export type StatsActions = {
  setTab(tab: string): void
  rescan(): void
  toggleWarm(): void
  cyclePreflight(): void
  handoff(): void
  measure(): void
}

export type StatsData = {
  live: Live
  hist: History | null
  tab: string
  now: number
  prefs: Prefs
  scanning: string
  dailyBudget: number
  keepWarmMinutes: number
  bloat: Bloat | null
}

const TABS: readonly (readonly [string, string])[] = [
  ['now', 'Now'],
  ['context', 'Context'],
  ['days', 'Days'],
  ['weeks', 'Weeks'],
  ['months', 'Months'],
  ['models', 'Models'],
  ['projects', 'Projects'],
  ['sessions', 'Sessions'],
  ['tips', 'Tips'],
]

const BARS = '▁▂▃▄▅▆▇█'

function bar(value: number, max: number, width = 10): string {
  if (max <= 0) return ''
  const n = Math.round((value / max) * width)

  return '█'.repeat(n) + '░'.repeat(Math.max(0, width - n))
}

function promptTokens(r: HistoryRow): number {
  return r.cacheRead + r.input + r.write5m + r.write1h
}

function periodTable(rows: readonly HistoryRow[], first: string): string {
  const max = Math.max(0, ...rows.map(r => r.usd))
  const head = `| ${first} | Requests | Input | Output | Cache read | Cache write | Cost | |\n|---|--:|--:|--:|--:|--:|--:|---|`
  const lines = rows.map(
    r =>
      `| ${r.label} | ${r.req || '·'} | ${tok(r.input)} | ${tok(r.output)} | ${tok(r.cacheRead)} | ${tok(r.write5m + r.write1h)} | ${r.usd ? usd(r.usd) : '·'} | ${bar(r.usd, max)} |`,
  )
  const sum = rows.reduce(
    (s, r) => ({ req: s.req + r.req, usd: s.usd + r.usd, output: s.output + r.output }),
    { req: 0, usd: 0, output: 0 },
  )

  return [head, ...lines, `| **Total** | **${sum.req}** | | **${tok(sum.output)}** | | | **${usd(sum.usd)}** | |`].join('\n')
}

function modelTable(rows: readonly HistoryRow[]): string {
  const all = rows.reduce((s, r) => s + r.usd, 0)
  const head = '| Model | Requests | Output | Cache hit | Cost | Share |\n|---|--:|--:|--:|--:|---|'
  const lines = rows.map(r => {
    const prompt = promptTokens(r)
    const hit = prompt > 0 ? `${Math.round((r.cacheRead / prompt) * 100)}%` : '–'

    return `| ${r.label} | ${r.req} | ${tok(r.output)} | ${hit} | ${usd(r.usd)} | ${bar(r.usd, all)} ${all > 0 ? Math.round((r.usd / all) * 100) : 0}% |`
  })

  return [head, ...lines].join('\n')
}

function listTable(rows: readonly HistoryRow[], first: string, withLast: boolean): string {
  const max = Math.max(0, ...rows.map(r => r.usd))
  const head = withLast
    ? `| ${first} | Last active | Requests | Cost | |\n|---|---|--:|--:|---|`
    : `| ${first} | Requests | Output | Cost | |\n|---|--:|--:|--:|---|`
  const lines = rows.map(r =>
    withLast
      ? `| ${r.label} | ${r.last ? `${new Date(r.last).toLocaleDateString()} ${clock(r.last)}` : '–'} | ${r.req} | ${usd(r.usd)} | ${bar(r.usd, max)} |`
      : `| ${r.label} | ${r.req} | ${tok(r.output)} | ${usd(r.usd)} | ${bar(r.usd, max)} |`,
  )

  return [head, ...lines].join('\n')
}

function sparkline(rows: readonly HistoryRow[]): string {
  const max = Math.max(0, ...rows.map(r => r.usd))
  if (max <= 0) return '(no requests in the last 24 hours)'

  return rows.map(r => (r.usd <= 0 ? ' ' : (BARS[Math.min(7, Math.floor((r.usd / max) * 7.99))] ?? '█'))).join('')
}

export function statsView(ui: UI, d: StatsData, act: StatsActions) {
  const { Box, Text, Button, Markdown } = ui
  const hist = d.hist

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {TABS.map(([key, label]) => (
          <Button
            key={`tab-${key}`}
            label={label}
            variant={d.tab === key ? 'primary' : 'secondary'}
            onPress={() => act.setTab(key)}
          />
        ))}
      </Box>
      {d.tab === 'now' && nowView(ui, d, act)}
      {d.tab === 'days' && hist && (
        <Box flexDirection="column" rowGap={1}>
          <Markdown text={periodTable(hist.days, 'Day')} />
          <Text bold>Last 24 hours, by hour (cost)</Text>
          <Text mono>{sparkline(hist.hours)}</Text>
          <Text dimColor mono>{`${hist.hours[0]?.label ?? ''}h${' '.repeat(Math.max(0, hist.hours.length - 6))}now`}</Text>
        </Box>
      )}
      {d.tab === 'weeks' && hist && <Markdown text={periodTable(hist.weeks, 'Week')} />}
      {d.tab === 'months' && hist && <Markdown text={periodTable(hist.months, 'Month')} />}
      {d.tab === 'models' && hist && (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>Last 30 days</Text>
          <Markdown text={hist.models.length ? modelTable(hist.models) : 'No requests in the last 30 days.'} />
        </Box>
      )}
      {d.tab === 'projects' && hist && (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>Last 30 days, by working folder</Text>
          <Markdown text={hist.projects.length ? listTable(hist.projects, 'Project', false) : 'No requests in the last 30 days.'} />
        </Box>
      )}
      {d.tab === 'sessions' && hist && (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>Most expensive chats, last 30 days</Text>
          <Markdown text={hist.sessions.length ? listTable(hist.sessions, 'Chat', true) : 'No requests in the last 30 days.'} />
        </Box>
      )}
      {d.tab === 'context' && contextView(ui, d, act)}
      {d.tab === 'tips' && <Markdown text={tips(d.live, hist, d.now).map(t => `- ${t}`).join('\n')} />}
      {d.tab !== 'now' && d.tab !== 'tips' && d.tab !== 'context' && !hist && <Text dimColor>Reading your transcripts…</Text>}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="rescan" label={d.scanning ? 'Scanning…' : 'Rescan transcripts'} onPress={() => act.rescan()} />
        <Button key="warm" label={`Keep-warm: ${d.prefs.keepWarm ? 'on' : 'off'}`} onPress={() => act.toggleWarm()} />
        <Button key="pf-mode" label={`Preflight: ${d.prefs.preflight}`} onPress={() => act.cyclePreflight()} />
        <Button key="handoff" label="Handoff…" onPress={() => act.handoff()} />
      </Box>
      <Text dimColor>
        {`Costs are theoretical: API list prices for the tokens used (a subscription is billed flat). ` +
          (hist
            ? hist.source === 'ledger'
              ? `No Claude Code transcripts here (Cowork keeps its own), so history is this mod's own log, updated ${clock(hist.scannedAt)}.`
              : `History from ${hist.files} transcript files, scanned ${clock(hist.scannedAt)}${d.scanning ? ` · ${d.scanning}` : ''}.`
            : d.scanning || 'History not scanned yet.')}
      </Text>
    </Box>
  )
}

function nowView(ui: UI, d: StatsData, act: StatsActions) {
  const { Box, Text, Progress, Button } = ui
  const { live, hist, now } = d
  const ttl = ttlOf(live)
  const ctx = live.contextTokens ?? 0
  const cost = contextCost(ctx, live.model, ttl)
  const cache = cacheState(live, now)
  const keepWarmUntil = live.lastRefreshAt + live.ttlMs + d.keepWarmMinutes * 60_000

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Usage limits</Text>
      {live.rateLimits.length === 0 && (
        <Text dimColor>No limit reading yet: it arrives with the first reply on a Pro, Max, Team or Enterprise plan.</Text>
      )}
      {live.rateLimits.map(w => {
        const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN
        const left = Number.isFinite(resets) ? resets - now : undefined
        const rate = burnRate(live.samples, w.kind, now)
        const spent = hist?.windows[w.kind]
        const eta = rate && rate > 0 ? ((100 - w.percentUsed) / rate) * 3_600_000 : undefined
        const pace =
          rate === undefined
            ? 'Burn rate: needs a few more readings.'
            : rate === 0
              ? 'Burn rate: flat over the last hour.'
              : `Burn rate ≈ ${rate.toFixed(1)}%/h → ` +
                (eta !== undefined && left !== undefined && eta < left
                  ? `reaches 100% at ${clock(now + eta)}, ${dur(left - eta)} before the reset.`
                  : 'stays under the limit until it resets.')

        return (
          <Box key={`lim-${w.kind}`} flexDirection="column">
            <Progress
              label={windowName(w.kind)}
              value={Math.min(1, Math.max(0, w.percentUsed / 100))}
              valueText={`${w.percentUsed}% used · ${Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)}% left`}
              color={levelColor(w.percentUsed)}
            />
            <Text dimColor>
              {(left !== undefined ? `Resets ${clock(resets)} (in ${dur(left)}). ` : '') + pace}
            </Text>
            <Text dimColor>
              {projectionLine(w, now)}
            </Text>
            {spent && windowMs(w.kind) !== undefined && (
              <Text dimColor>
                {`Claude Code in this window: ${usd(spent.usd)} at API prices, ${spent.req} requests` +
                  (w.percentUsed >= 1 ? ` (≈ ${usd(spent.usd / w.percentUsed)} per 1%, claude.ai and Cowork share it)` : '') +
                  '.'}
              </Text>
            )}
          </Box>
        )
      })}

      <Text bold>This chat</Text>
      <Progress
        label="Context window"
        value={live.contextWindow > 0 ? Math.min(1, ctx / live.contextWindow) : 0}
        valueText={`${tok(ctx)} of ${tok(live.contextWindow)} (${pct(live.contextPercent)})`}
        color={levelColor(live.contextPercent ?? 0)}
      />
      <Text dimColor>
        {`Every request re-reads it: ≈ ${usd(cost.warm)} while cached, ${usd(cost.cold)} after a cold start` +
          (live.model ? ` (${modelLabel(live.model)} prices).` : '.')}
      </Text>
      {cache.isWarm ? (
        <Text color={cache.isCooling ? 'warning' : 'success'}>
          {`${cache.isCooling ? '◐ Cache cooling' : '● Cache hot'}: expires in ${dur(cache.leftMs)} (${live.ttlLabel} lifetime, ${live.ttlSource}).`}
        </Text>
      ) : cache.hasCache ? (
        <Text color="warning">
          {`○ Cache cold for ${dur(-cache.leftMs)}: your next message re-writes ≈ ${tok(ctx)} tokens (+${usd(cost.cold - cost.warm)}).`}
        </Text>
      ) : (
        <Text dimColor>○ No request in this chat yet.</Text>
      )}
      <Text dimColor>
        {`Keep-warm ${d.prefs.keepWarm ? `on, for up to ${d.keepWarmMinutes} min past the lifetime` : 'off'}` +
          (live.warm.pings ? ` · ${live.warm.pings} pings, ${usd(live.warm.usd)}` : '') +
          (d.prefs.keepWarm && cache.hasCache && now < keepWarmUntil ? ` · until ${clock(keepWarmUntil)}` : '') +
          ` · one ping ≈ ${usd(cost.warm)} vs a cold restart ≈ ${usd(cost.cold)}` +
          (live.warm.note ? ` · ${live.warm.note}` : '')}
      </Text>
      <Text>
        {`Session ${usd(live.sessionUsd ?? live.ownUsd)} · ${live.steps} requests · in ${tok(live.tokens.input)} · out ${tok(live.tokens.output)} · ` +
          `cache read ${tok(live.tokens.cacheRead)} · cache write ${tok(live.tokens.cacheWrite)}`}
      </Text>
      {live.agentSteps > 0 && (
        <Text dimColor>{`Subagents: ${usd(live.agentsUsd)} over ${live.agentSteps} requests.`}</Text>
      )}
      {live.lastTurn && (
        <Text dimColor>
          {`Last turn: ${usd(live.lastTurn.usd)} · ${live.lastTurn.steps} requests · ${dur(live.lastTurn.ms)} · out ${tok(live.lastTurn.output)}`}
        </Text>
      )}
      {live.lastMiss && (
        <Text color="warning">
          {`Last cold start ${clock(live.lastMiss.at)}: re-wrote ${tok(live.lastMiss.tokens)} tokens ` +
            (live.lastMiss.idleMs > live.ttlMs
              ? `after ${dur(live.lastMiss.idleMs)} idle`
              : 'mid-chat (a model or effort switch, a compaction or a changed system prompt)') +
            ` (≈ ${usd(live.lastMiss.extraUsd)} extra).`}
        </Text>
      )}
      <Text dimColor>
        {`Model ${live.model ? modelLabel(live.model) : 'not known yet'} · effort ${live.effort ?? 'default'}` +
          (live.pendingEffort ? ` · next turn at ${live.pendingEffort}` : '')}
      </Text>

      <Text bold>Totals</Text>
      {hist ? (
        <Text>
          {`Today ${usd(hist.today.usd)} · this week ${usd(hist.week.usd)} · this month ${usd(hist.month.usd)} · all time ${usd(hist.total.usd)}`}
        </Text>
      ) : (
        <Text dimColor>{d.scanning || 'Reading your transcripts…'}</Text>
      )}
      {hist && d.dailyBudget > 0 && (
        <Progress
          label="Daily budget"
          value={Math.min(1, hist.today.usd / d.dailyBudget)}
          valueText={`${usd(hist.today.usd)} of ${usd(d.dailyBudget)}`}
          color={levelColor((hist.today.usd / d.dailyBudget) * 100)}
        />
      )}
      {hist && (
        <Text dimColor>
          {`Today: ${hist.today.req} requests, out ${tok(hist.today.output)}, cache read ${tok(hist.today.cacheRead)}, cache write ${tok(hist.today.write5m + hist.today.write1h)}.`}
        </Text>
      )}
      <Box flexDirection="row" columnGap={1}>
        <Button key="tips" label="Show tips" plain onPress={() => act.setTab('tips')} />
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- preflight pane

export type PreflightActions = {
  send(which: 'mine' | 'improved'): void
  edit(which: 'mine' | 'improved'): void
  setEffort(level: string): void
  cancel(): void
  retry(): void
}

export function preflightView(ui: UI, p: Preflight, live: Live, now: number, act: PreflightActions) {
  const { Box, Text, Button, Select, Progress, Markdown } = ui
  const ttl = ttlOf(live)
  const current = live.effort ?? 'default'
  const chosen = p.chosenEffort === 'keep' ? (live.effort ?? 'medium') : p.chosenEffort
  const est = p.base ? estimateTurn(p.base, chosen, ttl) : undefined
  const five = live.rateLimits.find(w => w.kind === 'five_hour')
  const cache = cacheState(live, now)
  const changesEffort = p.chosenEffort !== 'keep' && p.chosenEffort !== live.effort
  const cold = contextCost(live.contextTokens ?? 0, live.model, ttl)

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text dimColor>Your prompt</Text>
      <Text>{p.text.length > 600 ? p.text.slice(0, 600) + '…' : p.text}</Text>
      {p.status === 'thinking' && <Progress label="Checking effort, plan, cost and a clearer prompt…" />}
      {p.status === 'error' && <Text color="error">{`Preflight failed: ${p.error ?? 'no answer'}. You can still send as written.`}</Text>}
      {p.status === 'ready' && (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text bold>Suggested effort:</Text>
            <Text bold color={p.effort === 'low' ? 'success' : p.effort === 'max' || p.effort === 'xhigh' ? 'warning' : 'text'}>
              {(p.effort ?? 'medium').toUpperCase()}
            </Text>
            <Text dimColor>{`(now ${current}${p.complexity ? ` · ${p.complexity} task` : ''})`}</Text>
          </Box>
          {p.effortReason && <Text dimColor>{p.effortReason}</Text>}
          {p.plan && p.plan.length > 0 && (
            <Markdown text={'**What Claude will likely do**\n' + p.plan.map((s, i) => `${i + 1}. ${s}`).join('\n')} />
          )}
          {est && (
            <Box flexDirection="column">
              <Text bold>{`Estimated cost at ${chosen}: ≈ ${usd(est.usd)} (${usd(est.low)}–${usd(est.high)})`}</Text>
              <Text dimColor>
                {`≈ ${est.steps} requests · ≈ ${tok(est.output)} tokens written · context ${tok(p.base?.context)}` +
                  (cache.isWarm
                    ? ` · cache hot (${shortDur(cache.leftMs)} left)`
                    : cache.hasCache
                      ? ` · cache cold: +${usd(cold.cold - cold.warm)} to re-write it`
                      : '') +
                  (five && five.percentUsed > 0 ? ` · 5-hour limit now ${five.percentUsed}%` : '')}
              </Text>
            </Box>
          )}
          {p.savings && <Text color="suggestion">{`Cheaper: ${p.savings}`}</Text>}
          {p.questions && p.questions.length > 0 && (
            <Markdown text={'**Worth settling first**\n' + p.questions.map(q => `- ${q}`).join('\n')} />
          )}
          {p.improved && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text dimColor>Improved prompt</Text>
              <Text>{p.improved}</Text>
            </Box>
          )}
        </Box>
      )}
      <Select
        key="pf-effort"
        label="Effort for this send"
        value={p.chosenEffort}
        options={[
          { value: 'keep', label: `Keep session's (${current})` },
          ...EFFORTS.map(level => ({ value: level, label: level === p.effort ? `${level} (suggested)` : level })),
        ]}
        onSelect={value => act.setEffort(value)}
      />
      {changesEffort && (
        <Text dimColor>
          {`Applies to this turn only. On models without per-message effort a change restarts the cache once (≈ ${usd(cold.cold)}).`}
        </Text>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {p.improved && (
          <Button key="pf-send-improved" label="Send improved" variant="primary" onPress={() => act.send('improved')} />
        )}
        <Button
          key="pf-send-mine"
          label="Send mine"
          variant={p.improved ? 'secondary' : 'primary'}
          onPress={() => act.send('mine')}
        />
        {p.improved && <Button key="pf-edit-improved" label="Edit improved" onPress={() => act.edit('improved')} />}
        <Button key="pf-edit-mine" label="Edit mine" onPress={() => act.edit('mine')} />
        {p.status === 'error' && <Button key="pf-retry" label="Retry" onPress={() => act.retry()} />}
        <Button key="pf-cancel" label="Cancel" role="dismiss" onPress={() => act.cancel()} />
      </Box>
      {p.helperUsd !== undefined && <Text dimColor>{`This check cost ${usd(p.helperUsd)}.`}</Text>}
    </Box>
  )
}

// ---------------------------------------------------------------- handoff pane

export type HandoffActions = {
  continueFresh(): void
  copy(): void
  insert(): void
  regenerate(): void
  close(): void
}

export function handoffView(ui: UI, doc: Handoff, act: HandoffActions) {
  const { Box, Text, Button, Progress, Markdown } = ui

  return (
    <Box flexDirection="column" rowGap={1}>
      {doc.status === 'writing' && <Progress label="Writing the handoff from this chat (reads the cached context)…" />}
      {doc.status === 'error' && <Text color="error">{`Handoff failed: ${doc.error ?? 'no answer'}`}</Text>}
      {doc.status === 'ready' && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="ho-fresh" label="Continue in a fresh chat" variant="primary" onPress={() => act.continueFresh()} />
          <Button key="ho-copy" label="Copy" onPress={() => act.copy()} />
          <Button key="ho-insert" label="Put in prompt" onPress={() => act.insert()} />
          <Button key="ho-again" label="Write again" onPress={() => act.regenerate()} />
          <Button key="ho-close" label="Close" role="dismiss" onPress={() => act.close()} />
        </Box>
      )}
      {doc.status === 'ready' && (
        <Text dimColor>
          {`Continue in a fresh chat clears this context (/clear) and puts the handoff in the prompt for you to send.` +
            (doc.path ? ` Saved to ${doc.path}.` : '') +
            (doc.usd !== undefined ? ` Writing it cost ${usd(doc.usd)}.` : '')}
        </Text>
      )}
      {doc.text && <Markdown text={doc.text} />}
      {doc.status === 'error' && (
        <Box flexDirection="row" columnGap={1}>
          <Button key="ho-again" label="Try again" onPress={() => act.regenerate()} />
          <Button key="ho-close" label="Close" role="dismiss" onPress={() => act.close()} />
        </Box>
      )}
    </Box>
  )
}

function projectionLine(w: { kind: string; percentUsed: number; resetsAt?: string }, now: number): string {
  const at = projectAtReset(w, now)
  if (at === undefined) return 'Pace forecast: too early in this window.'
  const shown = Math.round(at)

  return shown >= 100
    ? `At this window's average pace you would run out before it resets (≈ ${shown}%).`
    : `At this window's average pace you end at ≈ ${shown}% when it resets.`
}

// ---------------------------------------------------------------- context tab

function contextView(ui: UI, d: StatsData, act: StatsActions) {
  const { Box, Text, Button, Markdown } = ui
  const b = d.bloat
  const ctx = d.live.contextTokens ?? 0
  if (!b) {
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text dimColor>Measuring what fills this chat…</Text>
        <Button key="ctx-measure" label="Measure now" onPress={() => act.measure()} />
      </Box>
    )
  }
  const max = Math.max(0, ...b.kinds.map(k => k.tokens))
  const fixed = Math.max(0, ctx - b.total)
  const kinds =
    '| What | Items | ≈ Tokens | |\n|---|--:|--:|---|\n' +
    b.kinds.map(k => `| ${k.kind} | ${k.count} | ${tok(k.tokens)} | ${bar(k.tokens, max)} |`).join('\n') +
    (ctx > 0 ? `\n| System prompt, tools, memory | | ≈ ${tok(fixed)} | |` : '')
  const items =
    '| Largest single items | ≈ Tokens |\n|---|--:|\n' +
    b.items.map(i => `| ${i.label.replace(/\|/g, '/')} | ${tok(i.tokens)} |`).join('\n')
  const big = b.items[0]
  const advice: string[] = []
  if (big && big.tokens > 8_000) {
    advice.push(
      `The biggest item is **${big.label}** (≈ ${tok(big.tokens)} tokens), re-read by every later request. ` +
        'Ask for line ranges, a grep, or a summary instead of whole files and logs.',
    )
  }
  const reads = b.kinds.find(k => k.kind === 'Read results')
  if (reads && b.total > 0 && reads.tokens / b.total > 0.4) {
    advice.push('File reads are most of this chat. Name the exact files and functions in your prompt so Claude reads less.')
  }
  if ((d.live.contextPercent ?? 0) >= 40) {
    advice.push('With this much context, a /handoff to a fresh chat is usually cheaper than carrying on.')
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text dimColor>{`Estimated from ${b.messages} messages (about 3.6 characters per token), measured ${clock(b.at)}.`}</Text>
      <Markdown text={kinds} />
      {b.items.length > 0 && <Markdown text={items} />}
      {advice.length > 0 && <Markdown text={advice.map(a => `- ${a}`).join('\n')} />}
      <Button key="ctx-measure" label="Measure again" onPress={() => act.measure()} />
    </Box>
  )
}
