import type { HistoryEntry, Pending } from '../types'

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const FULL_PERCENT = 100

/** The first retry waits this long; each next one waits twice as long. */
export const BASE_DELAY_MS = 30 * SECOND_MS
/** Backoff stops doubling here: 30s, 60s, 120s, 240s, 240s, ... */
export const MAX_DELAY_MS = 240 * SECOND_MS
/** A resume waits this long past the window's reset, so the first request lands in the new window. */
export const RESUME_MARGIN_MS = MINUTE_MS
/** How many history lines the session keeps. */
export const MAX_HISTORY = 50

export const DEFAULT_MAX_RETRIES = 4
export const DEFAULT_MAX_PER_SESSION = 20

export type Display = 'band' | 'status'

export type Settings = {
  maxRetries: number
  maxPerSession: number
  resumeAfterLimit: boolean
  display: Display
}

/** What the engine told us about a failed turn: the StopFailure kind (if it arrived) and the error text. */
export type Failure = { kind: string | undefined; text: string }

/**
 * transient: retry with backoff. limit: a usage or rate limit; resume at the reset when a window is used up.
 * fatal: retrying cannot help (auth, a bad request, a context that is too long).
 */
export type Verdict =
  | { kind: 'transient'; label: string }
  | { kind: 'limit'; label: string }
  | { kind: 'fatal'; label: string }

const FATAL_KINDS: Record<string, string> = {
  authentication_failed: 'authentication failed',
  oauth_org_not_allowed: 'organization not allowed',
  account_on_hold: 'account on hold',
  verification_required: 'verification required',
  billing_error: 'billing error',
  model_not_found: 'model not found',
  cloud_credential_error: 'cloud credentials error',
  max_output_tokens: 'output token limit',
}

const AUTH_FAILED = /failed to authenticate|invalid api key|run \/login|oauth (session|refresh token) (expired|is no longer valid)/i
const CONTEXT_TOO_LONG = /prompt is too long|context (window|length) (exceeded|is full)|exceeds? the (maximum )?context|maximum context length/i
const CREDITS_REQUIRED = /credits? required|out of extra usage|extra usage (is )?(disabled|off)/i
const LIMIT_TEXT = /usage limit|limit reached|hit your (\w+ )?limit|rate[ _-]?limit|\b429\b/i

/** Transient patterns in the order they are checked, the first match names the error. */
const TRANSIENT_TEXT: readonly (readonly [RegExp, string])[] = [
  [/could not be parsed/i, 'tool call could not be parsed'],
  [/stream idle timeout/i, 'stream idle timeout'],
  [/\b529\b|overloaded|at capacity/i, 'overloaded (529)'],
  [/\b(ECONN[A-Z]+|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)\b/, 'connection error'],
  [/socket hang up|connection (reset|error|refused|closed|was lost)|network error|fetch failed/i, 'connection error'],
  [/timed? ?out|timeout/i, 'timeout'],
  [/internal server error|bad gateway|service unavailable|gateway timeout/i, 'server error'],
]

const API_STATUS = /API Error:?\s*(\d{3})\b/i

const statusOf = (text: string): number | null => {
  const match = API_STATUS.exec(text)

  return match?.[1] === undefined ? null : Number(match[1])
}

const transientLabel = (text: string): string | null => {
  for (const [pattern, label] of TRANSIENT_TEXT) {
    const match = pattern.exec(text)

    if (match !== null) {
      return label === 'connection error' && /^E[A-Z]+$/.test(match[1] ?? '') ? `connection error (${match[1]})` : label
    }
  }

  return null
}

const HTTP_SERVER_ERROR = 500
const HTTP_CLIENT_ERROR = 400

/** Sorts a failed turn into retry, resume-at-reset or give-up. */
export const classify = (failure: Failure): Verdict => {
  const { kind, text } = failure
  const fatalKind = kind === undefined ? undefined : FATAL_KINDS[kind]

  if (fatalKind !== undefined) {
    return { kind: 'fatal', label: fatalKind }
  }

  if (AUTH_FAILED.test(text)) {
    return { kind: 'fatal', label: 'authentication failed' }
  }

  if (CONTEXT_TOO_LONG.test(text)) {
    return { kind: 'fatal', label: 'context too long' }
  }

  if (kind === 'rate_limit' || LIMIT_TEXT.test(text)) {
    return CREDITS_REQUIRED.test(text)
      ? { kind: 'fatal', label: 'usage credits required' }
      : { kind: 'limit', label: 'usage limit reached' }
  }

  const named = transientLabel(text)

  if (named !== null) {
    return { kind: 'transient', label: named }
  }

  const status = statusOf(text)

  if (status !== null && status >= HTTP_SERVER_ERROR) {
    return { kind: 'transient', label: `server error (${status})` }
  }

  if (kind === 'overloaded') {
    return { kind: 'transient', label: 'overloaded (529)' }
  }

  if (kind === 'server_error') {
    return { kind: 'transient', label: 'server error' }
  }

  if (kind === 'invalid_request' || (status !== null && status >= HTTP_CLIENT_ERROR)) {
    return { kind: 'fatal', label: status === null ? 'invalid request' : `invalid request (${status})` }
  }

  return { kind: 'fatal', label: kind === undefined || kind === 'unknown' ? 'unrecognised error' : kind }
}

/** Delay before retry number `attempt` (1-based). */
export const backoffMs = (attempt: number): number =>
  Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1))

type Window = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * When to resume after a limit: the latest reset among the windows that are used up, plus the margin.
 * Null when no window is used up (a short API rate limit, which a plain retry handles) or no reset is known.
 */
export const resumeAt = (windows: readonly Window[], now: number): number | null => {
  const resets = windows
    .filter(window => window.percentUsed >= FULL_PERCENT && window.resetsAt !== undefined)
    .map(window => Date.parse(window.resetsAt ?? ''))
    .filter(at => !Number.isNaN(at) && at > now)

  return resets.length === 0 ? null : Math.max(...resets) + RESUME_MARGIN_MS
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "0:45" under an hour, "1h 12m" above. */
export const countdown = (ms: number): string => {
  const clamped = Math.max(0, ms)

  if (clamped < HOUR_MS) {
    const seconds = Math.ceil(clamped / SECOND_MS)

    return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`
  }

  const minutes = Math.round(clamped / MINUTE_MS)

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const ago = (ms: number): string => {
  if (ms < MINUTE_MS) {
    return 'just now'
  }

  return ms < HOUR_MS ? `${Math.round(ms / MINUTE_MS)}m ago` : `${countdown(ms)} ago`
}

/** What the band and the status line say about a pending prompt. */
export const pendingLine = (pending: Pending, now: number): string =>
  pending.kind === 'retry'
    ? `keep-going: retry ${pending.attempt}/${pending.maxRetries} in ${countdown(pending.dueAt - now)}`
    : `keep-going: resuming at reset in ${countdown(pending.dueAt - now)}`

/** How often the countdown redraws: every second near the deadline, every minute when it is hours away. */
export const tickDelay = (remainingMs: number): number => (remainingMs > HOUR_MS ? MINUTE_MS : SECOND_MS)

export const retryPrompt = (label: string): string =>
  `The previous request failed with a transient API error (${label}). Continue the task from where you stopped; do not repeat finished steps.`

export const RESUME_PROMPT =
  'The usage limit has reset. Continue the task from where you stopped; do not repeat finished steps.'

/** The prompt origins that are the person at the keyboard (or the SDK host acting for them). */
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

export const isPerson = (originKind: string): boolean => PERSON_ORIGINS.has(originKind)

const COMMAND_PATTERN = /^\/keep-going(\s|$)/

/** True for `/keep-going ...` itself, which must not count as "the person took over". */
export const isOwnCommand = (text: string): boolean => COMMAND_PATTERN.test(text.trim())

export type CommandAction = 'status' | 'on' | 'off' | 'cancel'

export const parseCommand = (args: string): CommandAction | null => {
  const word = args.trim().toLowerCase()

  if (word === '' || word === 'status') {
    return 'status'
  }

  return word === 'on' || word === 'off' || word === 'cancel' ? word : null
}

const wholeAtLeast = (value: unknown, fallback: number, min: number): number => {
  const n = Number(value)

  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback
}

export const parseSettings = (options: Readonly<Record<string, unknown>>): Settings => ({
  maxRetries: wholeAtLeast(options.maxRetries ?? DEFAULT_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0),
  maxPerSession: wholeAtLeast(options.maxPerSession ?? DEFAULT_MAX_PER_SESSION, DEFAULT_MAX_PER_SESSION, 0),
  resumeAfterLimit: options.resumeAfterLimit !== false,
  display: options.display === 'status' ? 'status' : 'band',
})

export const addHistory = (list: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] =>
  [...list, entry].slice(-MAX_HISTORY)

type Block = { type: string; text?: unknown }

/** The visible text of a row's blocks. */
export const textOfBlocks = (blocks: readonly Block[]): string =>
  blocks
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(text => text !== '')
    .join('\n')

/** The model id the engine stamps on assistant rows it writes itself, API error messages among them. */
export const SYNTHETIC_MODEL = '<synthetic>'

/**
 * The text of an assistant row the engine wrote in the model's place (where "API Error: 529 ..." lands),
 * or null for anything else: a real model's words are never read as an error.
 */
export const engineRowText = (type: string, origin: { kind: string; model?: string }, blocks: readonly Block[]): string | null => {
  if (type !== 'assistant' || origin.kind !== 'model' || origin.model !== SYNTHETIC_MODEL) {
    return null
  }

  const text = textOfBlocks(blocks)

  return text === '' ? null : text
}

export type Snapshot = {
  isEnabled: boolean
  pending: Pending | null
  streak: number
  total: number
  history: readonly HistoryEntry[]
}

/** What `/keep-going` prints. */
export const report = (snapshot: Snapshot, settings: Settings, now: number): string => {
  const lines = [
    `Status: ${snapshot.isEnabled ? 'on' : 'off'} · retries in a row ${snapshot.streak}/${settings.maxRetries} · sent this session ${snapshot.total}/${settings.maxPerSession} · resume after limit ${settings.resumeAfterLimit ? 'on' : 'off'}`,
  ]

  lines.push(
    snapshot.pending === null
      ? 'Nothing pending.'
      : `Pending: ${pendingLine(snapshot.pending, now).replace(/^keep-going: /, '')} (${snapshot.pending.label}). /keep-going cancel stops it.`,
  )

  if (snapshot.history.length === 0) {
    lines.push('No API errors this session.')
  } else {
    lines.push('History:')

    for (const entry of snapshot.history) {
      lines.push(`  ${ago(now - entry.at)}: ${entry.text}`)
    }
  }

  return lines.join('\n')
}
