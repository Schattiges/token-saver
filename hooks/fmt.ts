const p2 = (n: number) => String(n).padStart(2, '0')

export function usd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '–'
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 10) return '$' + n.toFixed(2)
  if (n < 1000) return '$' + n.toFixed(1)

  return '$' + (n / 1000).toFixed(1) + 'k'
}

export function tok(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '–'
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k'

  return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M'
}

export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${p2(s % 60)}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${p2(m % 60)}m`

  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function shortDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${p2(m % 60)}`

  return `${Math.floor(h / 24)}d${h % 24}h`
}

/** How long the cache has been cold: minutes up to 3 hours, then hours, then days from 2 days on. */
export function coldDur(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 1) return 'just now'
  if (m < 180) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`

  return `${Math.floor(h / 24)}d`
}

export function clock(t: number): string {
  const d = new Date(t)

  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

export function dayKey(t: number): string {
  const d = new Date(t)

  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

export function weekKey(t: number): string {
  const d = new Date(t)
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))

  return dayKey(monday.getTime())
}

export function monthKey(t: number): string {
  const d = new Date(t)

  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function dayLabel(t: number): string {
  const d = new Date(t)

  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`
}

export function monthLabel(t: number): string {
  const d = new Date(t)

  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

export function pct(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? '–' : `${Math.round(n)}%`
}

export function windowName(kind: string): string {
  if (kind === 'five_hour') return '5-hour limit'
  if (kind === 'seven_day') return 'Weekly limit'
  if (kind === 'spend_limit') return 'Spend limit'

  return kind.replace(/_/g, ' ')
}

export function windowShort(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  if (kind === 'spend_limit') return '$'

  return kind.replace(/_/g, ' ').slice(0, 10)
}

export function windowMs(kind: string): number | undefined {
  if (kind === 'five_hour') return 5 * 3_600_000
  if (kind.startsWith('seven_day')) return 7 * 24 * 3_600_000

  return undefined
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)

  return parts[parts.length - 1] ?? path
}
