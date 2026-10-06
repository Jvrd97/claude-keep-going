import type { RenderInput, SessionRateLimit, SessionStartInput, SessionUsage, TurnCompleteInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const NOW = Date.parse('2026-10-06T12:00:00Z')
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DETAILS_GRACE = 2 * SEC
const COMPOSER = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: true, columns: 140 }

const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 140, rows: 40, isFullscreen: true },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
}

const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }

  if (node !== null && typeof node === 'object') {
    const element = node as { children?: unknown; props?: { label?: unknown } }
    const label = typeof element.props?.label === 'string' ? `[${element.props.label}]` : ''

    return label + textOf(element.children ?? []) + '\n'
  }

  return ''
}

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
type TestEngine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

const world = (on: TestOn) => {
  const state = { submitted: [] as string[], toasts: [] as string[], status: [] as (string | undefined)[], rateLimits: [] as SessionRateLimit[] }

  on('session.usage', (): { value: SessionUsage } => ({
    value: { startedAt: NOW, context: { window: 200_000, tokens: 10_000, percent: 5 }, rateLimits: state.rateLimits },
  }))
  on('prompt.submit', ($, e) => {
    // The test types as the composer; everything else reaching the bottom is the plugin's own prompt.
    const origin: { kind: string } | undefined = e.origin

    if (origin?.kind !== 'composer') {
      state.submitted.push(e.text)
    }

    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    state.status.push(e.text)

    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', children: [''] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))

  return state
}

let turns = 0

const turn = (reason: TurnCompleteInput['reason'], extra: Partial<TurnCompleteInput> = {}): TurnCompleteInput =>
  ({ answer: '', durationMs: 1000, isAborted: reason === 'aborted', turnId: `t${++turns}`, reason, ...extra }) as TurnCompleteInput

/** A main-loop turn dying on an API error, the way the engine reports it: StopFailure, then turn.complete. */
const fail = async ($: TestEngine, error: 'overloaded' | 'server_error' | 'rate_limit' | 'authentication_failed', details = '') => {
  await $.classic.StopFailure({ error, error_details: details })
  await $.turn.complete(turn('error'))
}

const typed = ($: TestEngine, text: string) => $.prompt.submit({ text, origin: COMPOSER, wait: false })

const runCommand = ($: TestEngine, args: string) =>
  $.command.run({ command: 'keep-going', args, origin: COMPOSER, presentation: PRESENTATION })

describe('retries after a transient error', () => {
  test('an overloaded turn is retried after 30s with the retry prompt', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded', 'API Error: 529 overloaded_error')

    await clock.advance(29 * SEC)
    expect(state.submitted).toEqual([])

    await clock.advance(1 * SEC)
    expect(state.submitted.length).toBe(1)
    expect(state.submitted[0]).toContain('transient API error (overloaded (529))')
    expect(state.submitted[0]).toContain('do not repeat finished steps')
  })

  test('a second failure in a row waits 60s', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'server_error', 'API Error: 500')
    await clock.advance(30 * SEC)
    await fail($, 'server_error', 'API Error: 500')

    await clock.advance(59 * SEC)
    expect(state.submitted.length).toBe(1)

    await clock.advance(1 * SEC)
    expect(state.submitted.length).toBe(2)
  })

  test('a successful turn resets the count, so the next failure waits 30s again', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')
    await clock.advance(30 * SEC)
    await $.turn.complete(turn('answer', { answer: 'done' }))
    await fail($, 'overloaded')

    await clock.advance(30 * SEC)
    expect(state.submitted.length).toBe(2)
    expect((await runCommand($, '')).text).toContain('retry count reset')
  })

  test("the turn's own error text is enough when StopFailure never comes", async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.turn.complete(turn('error', { answer: 'API Error: Stream idle timeout - no chunks received' }))

    await clock.advance(DETAILS_GRACE + 30 * SEC)
    expect(state.submitted[0]).toContain('stream idle timeout')
  })

  test('StopFailure arriving after the turn ended still decides', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.turn.complete(turn('error'))
    await $.classic.StopFailure({ error: 'server_error', error_details: 'API Error: 502 Bad Gateway' })

    await clock.advance(30 * SEC)
    expect(state.submitted.length).toBe(1)
  })
})

describe('what is never retried', () => {
  test('an aborted turn (Esc) schedules nothing', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'overloaded' })
    await $.turn.complete(turn('aborted'))

    await clock.advance(10 * MIN)
    expect(state.submitted).toEqual([])
  })

  test('a refusal schedules nothing', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.turn.complete({ ...turn('answer'), reason: 'refusal', refusal: { category: null, explanation: null } })

    await clock.advance(10 * MIN)
    expect(state.submitted).toEqual([])
  })

  test('an auth failure toasts why and schedules nothing', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'authentication_failed', 'API Error: 401')

    await clock.advance(10 * MIN)
    expect(state.submitted).toEqual([])
    expect(state.toasts.some(toast => toast.includes('not retrying: authentication failed'))).toBe(true)
  })

  test("a subagent's failed turn is not the main loop's business", async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.classic.StopFailure({ error: 'overloaded', agent_id: 'sub1' })
    await $.turn.complete(turn('error', { agentId: 'sub1' }))

    await clock.advance(10 * MIN)
    expect(state.submitted).toEqual([])
  })
})

describe('the person stays in charge', () => {
  test('anything the person types cancels the pending retry', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')
    await typed($, 'actually, stop and do X')

    await clock.advance(5 * MIN)
    expect(state.submitted).toEqual([])
    expect((await runCommand($, '')).text).toContain('retry cancelled: you sent a prompt')
  })

  test('/keep-going itself shows state without cancelling', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')
    await typed($, '/keep-going')

    expect((await runCommand($, '')).text).toContain('Pending: retry 1/4 in 0:30')

    await clock.advance(30 * SEC)
    expect(state.submitted.length).toBe(1)
  })

  test('/keep-going off stops retries until on', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await runCommand($, 'off')
    await fail($, 'overloaded')
    await clock.advance(5 * MIN)
    expect(state.submitted).toEqual([])

    await runCommand($, 'on')
    await fail($, 'overloaded')
    await clock.advance(30 * SEC)
    expect(state.submitted.length).toBe(1)
  })

  test('/keep-going cancel drops the pending retry', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')

    expect((await runCommand($, 'cancel')).text).toBe('Cancelled the pending retry.')
    await clock.advance(5 * MIN)
    expect(state.submitted).toEqual([])
  })

  test('a retry never fires while a turn is running; it waits for the session to go idle', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')
    await $.turn.start({ text: 'background notification', turnId: 'busy' })

    await clock.advance(40 * SEC)
    expect(state.submitted).toEqual([])

    await $.turn.complete(turn('aborted'))
    await clock.advance(5 * SEC)
    expect(state.submitted.length).toBe(1)
  })

  test('a reload drops the pending retry, since its timer died with the old module', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')
    await $.session.start(SESSION)

    await clock.advance(5 * MIN)
    expect(state.submitted).toEqual([])
    expect((await runCommand($, '')).text).toContain('cancelled: the module reloaded')
  })
})

describe('usage limits', () => {
  test('a limit with a known reset resumes one minute after it', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    state.rateLimits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }]
    await $.session.start(SESSION)
    await fail($, 'rate_limit', "You've hit your limit")

    expect((await runCommand($, '')).text).toContain('resuming at reset in 2h 1m')

    await clock.advance(2 * HOUR + 59 * SEC)
    expect(state.submitted).toEqual([])

    await clock.advance(1 * SEC)
    expect(state.submitted.length).toBe(1)
    expect(state.submitted[0]).toContain('The usage limit has reset')
  })

  test('a 429 with no used-up window is a short rate limit and gets a plain retry', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    state.rateLimits = [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }]
    await $.session.start(SESSION)
    await fail($, 'rate_limit', 'API Error: 429 rate_limit_error')

    await clock.advance(30 * SEC)
    expect(state.submitted[0]).toContain('(rate limited)')
  })

  test('with resumeAfterLimit off a limit only toasts', { options: { resumeAfterLimit: false } }, async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    state.rateLimits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + HOUR).toISOString() }]
    await $.session.start(SESSION)
    await fail($, 'rate_limit')

    await clock.advance(2 * HOUR)
    expect(state.submitted).toEqual([])
    expect(state.toasts.some(toast => toast.includes('resumeAfterLimit'))).toBe(true)
  })
})

describe('caps', () => {
  test('maxRetries in a row, then it gives up and says so', { options: { maxRetries: 2 } }, async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')
    await clock.advance(30 * SEC)
    await fail($, 'overloaded')
    await clock.advance(60 * SEC)
    await fail($, 'overloaded')
    await clock.advance(10 * MIN)

    expect(state.submitted.length).toBe(2)
    expect(state.toasts.some(toast => toast.includes('gave up after 2 retries'))).toBe(true)
  })

  test('maxPerSession caps the total even across successful turns', { options: { maxPerSession: 1 } }, async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')
    await clock.advance(30 * SEC)
    await $.turn.complete(turn('answer'))
    await fail($, 'overloaded')
    await clock.advance(10 * MIN)

    expect(state.submitted.length).toBe(1)
    expect(state.toasts.some(toast => toast.includes('maxPerSession'))).toBe(true)
  })
})

describe('display', () => {
  test('the band counts down and its cancel button works', async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    expect(textOf(await $.ui.render(BAND)).trim()).toBe('')

    await fail($, 'overloaded')
    expect(textOf(await $.ui.render(BAND))).toContain('keep-going: retry 1/4 in 0:30')

    await clock.advance(15 * SEC)
    const band = textOf(await $.ui.render(BAND))
    expect(band).toContain('in 0:15')
    expect(band).toContain('[cancel]')

    await $.ui.press({ plugin: 'keep-going', key: 'cancel' })
    expect(textOf(await $.ui.render(BAND)).trim()).toBe('')

    await clock.advance(5 * MIN)
    expect(state.submitted).toEqual([])
  })

  test('display "status" writes the countdown to the status line and draws no band', { options: { display: 'status' } }, async ($, on) => {
    const state = world(on)
    const clock = mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await fail($, 'overloaded')
    await clock.advance(10 * SEC)

    expect(state.status).toContain('keep-going: retry 1/4 in 0:20')
    expect(textOf(await $.ui.render(BAND)).trim()).toBe('')

    await clock.advance(20 * SEC)
    expect(state.status[state.status.length - 1]).toBeUndefined()
  })
})

type Mounted = { surface: string; unmount: () => Promise<void> }

describe('what the band draws is accepted by each surface', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the band validates on ${surface}, wide and narrow, for a retry and a resume`, async ($, on) => {
      const state = world(on)
      mock.clock(on, { now: NOW })
      await $.session.start(SESSION)

      for (const kind of ['retry', 'resume'] as const) {
        if (kind === 'retry') {
          await fail($, 'overloaded')
        } else {
          state.rateLimits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + HOUR).toISOString() }]
          await fail($, 'rate_limit')
        }

        for (const bodyColumns of [40, 120]) {
          const mounted = await ($ as unknown as { ui: { mount: (input: unknown) => Promise<Mounted> } }).ui.mount({
            ...BAND,
            surface,
            plugin: 'keep-going',
            props: { ...BAND.props, bodyColumns },
          })

          expect(mounted.surface).toBe(surface)
          await mounted.unmount()
        }
      }
    })
  }
})
