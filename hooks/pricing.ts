// API list prices in USD per million tokens (Anthropic first-party, Nov 2026).
// Subscription plans are billed flat: these figures are what the same tokens
// would cost on the API, the yardstick this mod calls "theoretical cost".

export type Rates = {
  input: number
  output: number
  write5m: number
  write1h: number
  read: number
}

export type UsageLike = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  /** Cache-write tokens by lifetime, when the source says (transcripts do). */
  write5m?: number
  write1h?: number
  speed?: string
}

const rate = (input: number, output: number, read: number): Rates => ({
  input,
  output,
  write5m: input * 1.25,
  write1h: input * 2,
  read,
})

// First match wins, so a more specific id comes before its family.
const TABLE: readonly (readonly [RegExp, Rates, string])[] = [
  [/fable-5-2|mythos-5-2/, rate(8, 40, 0.2), 'Fable 5.2'],
  [/fable-5-1|mythos-5-1/, rate(10, 50, 0.25), 'Fable 5.1'],
  [/fable-5|mythos/, rate(10, 50, 1), 'Fable 5'],
  [/opus-5-5/, rate(4, 20, 0.2), 'Opus 5.5'],
  [/opus-5|opus-4-[5-9]/, rate(5, 25, 0.5), 'Opus 5'],
  [/opus-4|opus-3|3-opus/, rate(15, 75, 1.5), 'Opus 4'],
  [/sonnet-5-5/, rate(2, 10, 0.1), 'Sonnet 5.5'],
  [/sonnet-5/, rate(2, 10, 0.2), 'Sonnet 5'],
  [/sonnet-4|sonnet-3|3-[57]-sonnet/, rate(3, 15, 0.3), 'Sonnet 4'],
  [/haiku-5-5/, rate(0.1, 0.5, 0.01), 'Haiku 5.5'],
  [/haiku-4-5/, rate(1, 5, 0.1), 'Haiku 4.5'],
  [/haiku/, rate(0.8, 4, 0.08), 'Haiku 3.5'],
]

// An alias or an unknown id falls back to the current model of its family.
const FAMILY: readonly (readonly [RegExp, Rates, string])[] = [
  [/fable|mythos/, rate(8, 40, 0.2), 'Fable'],
  [/opus/, rate(4, 20, 0.2), 'Opus'],
  [/sonnet/, rate(2, 10, 0.1), 'Sonnet'],
  [/haiku/, rate(0.1, 0.5, 0.01), 'Haiku'],
]

const FALLBACK = rate(4, 20, 0.2)

export function ratesFor(model: string): { rates: Rates; label: string; isGuess: boolean } {
  const id = model.toLowerCase()
  for (const [re, rates, label] of TABLE) {
    if (re.test(id)) return { rates, label, isGuess: false }
  }
  for (const [re, rates, label] of FAMILY) {
    if (re.test(id)) return { rates, label, isGuess: true }
  }
  return { rates: FALLBACK, label: model || 'unknown', isGuess: true }
}

export function modelLabel(model: string): string {
  const { label, isGuess } = ratesFor(model)
  return isGuess ? model : label
}

/** Theoretical USD cost of one request's usage. */
export function costOf(u: UsageLike, model: string, ttl: '5m' | '1h' = '5m'): number {
  const { rates } = ratesFor(model)
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  // Claude Haiku 5.5 costs 5x for prompts over 100K tokens.
  const tier = /haiku-5-5/.test(model) && prompt > 100_000 ? 5 : 1
  const fast = u.speed === 'fast' ? 2 : 1
  const write1h = u.write1h ?? (ttl === '1h' ? u.cache_creation_input_tokens : 0)
  const write5m = u.write5m ?? Math.max(0, u.cache_creation_input_tokens - write1h)
  const sum =
    u.input_tokens * rates.input +
    u.output_tokens * rates.output +
    u.cache_read_input_tokens * rates.read +
    write5m * rates.write5m +
    write1h * rates.write1h

  return (sum / 1e6) * tier * fast
}

/** What re-reading `tokens` of context costs, warm (cache read) and cold (cache write). */
export function contextCost(tokens: number, model: string, ttl: '5m' | '1h') {
  const { rates } = ratesFor(model)
  const write = ttl === '1h' ? rates.write1h : rates.write5m

  return { warm: (tokens * rates.read) / 1e6, cold: (tokens * write) / 1e6 }
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// Rough multipliers relative to medium, for estimates only.
const OUTPUT_FACTOR: Record<string, number> = { low: 0.45, medium: 1, high: 1.7, xhigh: 2.4, max: 3.4 }
const STEP_FACTOR: Record<string, number> = { low: 0.8, medium: 1, high: 1.15, xhigh: 1.3, max: 1.5 }

export type Estimate = { usd: number; low: number; high: number; steps: number; output: number }

/**
 * Estimates a turn: every request re-reads the context from the cache and
 * writes what the step added; a cold cache writes the whole context first.
 */
export function estimateTurn(
  base: { context: number; steps: number; output: number; isCold: boolean; model: string },
  effort: string,
  ttl: '5m' | '1h',
): Estimate {
  const { rates } = ratesFor(base.model)
  const write = ttl === '1h' ? rates.write1h : rates.write5m
  const steps = Math.max(1, Math.round(base.steps * (STEP_FACTOR[effort] ?? 1)))
  const output = Math.round(base.output * (OUTPUT_FACTOR[effort] ?? 1))
  const growth = 2_500 // tokens a typical tool step adds (its result plus the call)
  let input = 0
  for (let i = 0; i < steps; i++) {
    const context = base.context + i * growth
    input += context * rates.read + growth * write
  }
  if (base.isCold) input += base.context * (write - rates.read)
  const usd = (input + output * rates.output) / 1e6

  return { usd, low: usd * 0.55, high: usd * 1.9, steps, output }
}
