import { describe, expect, test } from 'claude-code/testing'

import {
  backoffMs,
  classify,
  countdown,
  engineRowText,
  isOwnCommand,
  isPerson,
  parseCommand,
  parseSettings,
  pendingLine,
  report,
  resumeAt,
  retryPrompt,
  textOfBlocks,
  tickDelay,
} from '../hooks/logic'

const SEC = 1000
const MIN = 60 * SEC
const NOW = Date.parse('2026-10-06T12:00:00Z')

describe('classify', () => {
  test('server-side and network failures are transient, each with a readable label', () => {
    expect(classify({ kind: 'overloaded', text: '' })).toEqual({ kind: 'transient', label: 'overloaded (529)' })
    expect(classify({ kind: 'server_error', text: 'API Error: 529 The API is at capacity' }).label).toBe('overloaded (529)')
    expect(classify({ kind: 'server_error', text: 'API Error: 500 {"type":"api_error"}' })).toEqual({
      kind: 'transient',
      label: 'server error (500)',
    })
    expect(classify({ kind: 'unknown', text: 'API Error: 503 Service Unavailable' }).kind).toBe('transient')
    expect(classify({ kind: undefined, text: 'Stream idle timeout - no chunks received' }).label).toBe('stream idle timeout')
    expect(classify({ kind: undefined, text: 'API Error: Request timed out.' }).label).toBe('timeout')
    expect(classify({ kind: 'unknown', text: 'API Error: Connection to the API was lost (ECONNRESET).' }).label).toBe(
      'connection error (ECONNRESET)',
    )
    expect(classify({ kind: undefined, text: "The model's tool call could not be parsed (retry also failed)." }).label).toBe(
      'tool call could not be parsed',
    )
  })

  test('usage and rate limits are limits, unless the fix is buying credits', () => {
    expect(classify({ kind: 'rate_limit', text: "You've hit your limit · resets 3pm" }).kind).toBe('limit')
    expect(classify({ kind: undefined, text: 'Claude usage limit reached.' }).kind).toBe('limit')
    expect(classify({ kind: 'rate_limit', text: 'API Error: Usage credits required for 1M context' })).toEqual({
      kind: 'fatal',
      label: 'usage credits required',
    })
  })

  test('auth, bad requests and a full context are never retried', () => {
    expect(classify({ kind: 'authentication_failed', text: 'API Error: 500' })).toEqual({ kind: 'fatal', label: 'authentication failed' })
    expect(classify({ kind: 'billing_error', text: '' }).kind).toBe('fatal')
    expect(classify({ kind: undefined, text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }).label).toBe(
      'authentication failed',
    )
    expect(classify({ kind: 'server_error', text: 'Failed to refresh OAuth token: another Claude Code process is refreshing it' }).kind).toBe(
      'transient',
    )
    expect(classify({ kind: 'invalid_request', text: 'API Error: 400 messages: field required' })).toEqual({
      kind: 'fatal',
      label: 'invalid request (400)',
    })
    expect(classify({ kind: 'invalid_request', text: 'Prompt is too long' })).toEqual({ kind: 'fatal', label: 'context too long' })
    expect(classify({ kind: undefined, text: 'API Error: 404 not_found_error' }).kind).toBe('fatal')
  })

  test('an error nobody can name is not retried', () => {
    expect(classify({ kind: 'unknown', text: 'something odd' })).toEqual({ kind: 'fatal', label: 'unrecognised error' })
    expect(classify({ kind: undefined, text: '' }).kind).toBe('fatal')
  })
})

describe('timing', () => {
  test('backoff doubles from 30s and stops at 240s', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([30, 60, 120, 240, 240, 240].map(s => s * SEC))
  })

  test('resume waits for the latest reset among the used-up windows, plus a minute', () => {
    const windows = [
      { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-06T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-09T00:00:00Z' },
    ]

    expect(resumeAt(windows, NOW)).toBe(Date.parse('2026-10-06T14:01:00Z'))
    expect(resumeAt([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-06T14:00:00Z' }, { ...windows[1]!, percentUsed: 100 }], NOW)).toBe(
      Date.parse('2026-10-09T00:01:00Z'),
    )
  })

  test('no used-up window, no known reset or a reset in the past means no resume time', () => {
    expect(resumeAt([{ kind: 'five_hour', percentUsed: 87, resetsAt: '2026-10-06T14:00:00Z' }], NOW)).toBeNull()
    expect(resumeAt([{ kind: 'five_hour', percentUsed: 100 }], NOW)).toBeNull()
    expect(resumeAt([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-06T11:00:00Z' }], NOW)).toBeNull()
    expect(resumeAt([], NOW)).toBeNull()
  })

  test('countdowns read as m:ss under an hour and as hours above', () => {
    expect(countdown(45 * SEC)).toBe('0:45')
    expect(countdown(30 * SEC)).toBe('0:30')
    expect(countdown(4 * MIN + 1)).toBe('4:01')
    expect(countdown(72 * MIN)).toBe('1h 12m')
    expect(countdown(-5)).toBe('0:00')
  })

  test('the countdown ticks every second near the deadline and every minute when hours away', () => {
    expect(tickDelay(30 * SEC)).toBe(SEC)
    expect(tickDelay(3 * 60 * MIN)).toBe(MIN)
  })
})

describe('text', () => {
  test('the pending line names the attempt or the reset', () => {
    expect(pendingLine({ kind: 'retry', attempt: 2, maxRetries: 4, dueAt: NOW + 45 * SEC, label: 'x' }, NOW)).toBe(
      'keep-going: retry 2/4 in 0:45',
    )
    expect(pendingLine({ kind: 'resume', dueAt: NOW + 72 * MIN, label: 'x' }, NOW)).toBe('keep-going: resuming at reset in 1h 12m')
  })

  test('the retry prompt names the error and asks not to repeat work', () => {
    const prompt = retryPrompt('overloaded (529)')

    expect(prompt).toContain('(overloaded (529))')
    expect(prompt).toContain('do not repeat finished steps')
  })

  test('only the engine\'s own assistant rows are read as error text', () => {
    const blocks = [{ type: 'text', text: 'API Error: 529 overloaded' }]

    expect(engineRowText('assistant', { kind: 'model', model: '<synthetic>' }, blocks)).toBe('API Error: 529 overloaded')
    expect(engineRowText('assistant', { kind: 'model', model: 'claude-opus-5-5' }, blocks)).toBeNull()
    expect(engineRowText('user', { kind: 'composer' }, blocks)).toBeNull()
    expect(engineRowText('assistant', { kind: 'model', model: '<synthetic>' }, [])).toBeNull()
  })

  test('only text blocks count as a row text', () => {
    expect(textOfBlocks([{ type: 'text', text: 'API Error: 500' }, { type: 'thinking' }, { type: 'text', text: 'b' }])).toBe('API Error: 500\nb')
  })

  test('the report shows switches, counters, the pending retry and the history', () => {
    const text = report(
      {
        isEnabled: true,
        pending: { kind: 'retry', attempt: 1, maxRetries: 4, dueAt: NOW + 30 * SEC, label: 'overloaded (529)' },
        streak: 0,
        total: 2,
        history: [{ at: NOW - 5 * MIN, text: 'retry 1/4 sent' }],
      },
      parseSettings({}),
      NOW,
    )

    expect(text).toContain('Status: on')
    expect(text).toContain('sent this session 2/20')
    expect(text).toContain('Pending: retry 1/4 in 0:30 (overloaded (529))')
    expect(text).toContain('5m ago: retry 1/4 sent')
  })
})

describe('input', () => {
  test('commands parse and junk is refused', () => {
    expect(parseCommand('')).toBe('status')
    expect(parseCommand(' OFF ')).toBe('off')
    expect(parseCommand('cancel')).toBe('cancel')
    expect(parseCommand('please')).toBeNull()
  })

  test('settings fall back to safe defaults', () => {
    expect(parseSettings({})).toEqual({ maxRetries: 4, maxPerSession: 20, resumeAfterLimit: true, display: 'band' })
    expect(parseSettings({ maxRetries: -3, maxPerSession: 'x', resumeAfterLimit: false, display: 'status' })).toEqual({
      maxRetries: 0,
      maxPerSession: 20,
      resumeAfterLimit: false,
      display: 'status',
    })
  })

  test('the person is the composer, the bridge or the SDK host, never a plugin or a notification', () => {
    expect(isPerson('composer')).toBe(true)
    expect(isPerson('sdk')).toBe(true)
    expect(isPerson('plugin')).toBe(false)
    expect(isPerson('task-notification')).toBe(false)
  })

  test('/keep-going itself does not count as taking over', () => {
    expect(isOwnCommand('/keep-going')).toBe(true)
    expect(isOwnCommand('/keep-going cancel')).toBe(true)
    expect(isOwnCommand('/keep-goingness')).toBe(false)
    expect(isOwnCommand('continue')).toBe(false)
  })
})
