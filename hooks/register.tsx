import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, Timer, TurnCompleteReason } from 'claude-code'

import type { Pending } from '../types'
import {
  addHistory,
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
  RESUME_PROMPT,
  tickDelay,
} from './logic'
import type { Settings, Verdict } from './logic'

const COMMAND = 'keep-going'
/** How long to wait for the StopFailure details when a turn ends on an error with no text to classify. */
const DETAILS_GRACE_MS = 2_000
/** When a retry falls due while another turn runs, check again after this long. */
const RECHECK_MS = 5_000
const NOTICE_TOAST_MS = 8_000

const pendingAtom = atom({ plugin: 'keep-going', key: 'pending' } as const, null)
const streakAtom = atom({ plugin: 'keep-going', key: 'streak' } as const, 0)
const totalAtom = atom({ plugin: 'keep-going', key: 'total' } as const, 0)
const isEnabledAtom = atom({ plugin: 'keep-going', key: 'isEnabled' } as const, true)
const historyAtom = atom({ plugin: 'keep-going', key: 'history' } as const, [])
const tickAtom = atom({ plugin: 'keep-going', key: 'tick' } as const, 0)

/**
 * What lives only as long as this load of the module. Timers die with it on a hot reload (the engine
 * cancels them), which is why session.start drops a pending retry it finds in state.
 */
type Runtime = {
  settings: Settings
  timer: Timer | null
  ticker: Timer | null
  grace: Timer | null
  isTurnRunning: boolean
  /** The main-loop turn that ended on an error and still waits for a verdict. */
  failedTurn: string | null
  stopFailure: { kind: string; details: string } | null
  /** Text of the engine's own stand-in assistant row this turn: where its API error message lands. */
  errorText: string
  /** The failed turn's final visible text: a weak fallback when nothing else says what went wrong. */
  answer: string
}

function stopTimers(rt: Runtime): void {
  rt.timer?.cancel()
  rt.ticker?.cancel()
  rt.timer = null
  rt.ticker = null
}

async function note($: EngineInterface, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, historyAtom, list => addHistory(list, { at, text }))
}

async function clearPending($: EngineInterface, rt: Runtime): Promise<Pending | null> {
  stopTimers(rt)
  const was = await read($, pendingAtom)
  await update($, pendingAtom, () => null)

  if (rt.settings.display === 'status') {
    $.ui.status(undefined)
  }

  return was
}

async function cancelPending($: EngineInterface, rt: Runtime, why: string): Promise<void> {
  const was = await clearPending($, rt)

  if (was !== null) {
    await note($, `${was.kind} cancelled: ${why}`)
  }
}

async function showTick($: EngineInterface, rt: Runtime): Promise<void> {
  rt.ticker = null
  const pending = await read($, pendingAtom)

  if (pending === null) {
    return
  }

  const now = await $.clock.now()
  await update($, tickAtom, n => n + 1)

  if (rt.settings.display === 'status') {
    $.ui.status(pendingLine(pending, now))
  }

  rt.ticker = $.clock.after(tickDelay(pending.dueAt - now), () => {
    void showTick($, rt)
  })
}

async function schedule($: EngineInterface, rt: Runtime, pending: Pending): Promise<void> {
  stopTimers(rt)
  const now = await $.clock.now()
  await update($, pendingAtom, () => pending)
  rt.timer = $.clock.after(Math.max(0, pending.dueAt - now), () => {
    void fire($, rt)
  })
  await showTick($, rt)
}

async function fire($: EngineInterface, rt: Runtime): Promise<void> {
  rt.timer = null
  const pending = await read($, pendingAtom)

  if (pending === null) {
    return
  }

  if (rt.isTurnRunning) {
    rt.timer = $.clock.after(RECHECK_MS, () => {
      void fire($, rt)
    })

    return
  }

  await clearPending($, rt)
  await update($, totalAtom, n => n + 1)

  if (pending.kind === 'retry') {
    await update($, streakAtom, () => pending.attempt)
  }

  await note($, pending.kind === 'retry' ? `retry ${pending.attempt}/${pending.maxRetries} sent` : 'resume sent after the limit reset')

  try {
    const sent = await $.prompt.submit({ text: pending.kind === 'retry' ? retryPrompt(pending.label) : RESUME_PROMPT })

    if (sent.drop !== undefined) {
      await refuse($, `the ${pending.kind} prompt was dropped: ${sent.drop}`)
    }
  } catch (error) {
    await refuse($, `could not send the ${pending.kind} prompt: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function refuse($: EngineInterface, why: string): Promise<void> {
  $.ui.toast(`keep-going: ${why}`, { timeoutMs: NOTICE_TOAST_MS })
  await note($, why)
}

async function scheduleRetry($: EngineInterface, rt: Runtime, label: string): Promise<void> {
  const streak = await read($, streakAtom)
  const { maxRetries } = rt.settings

  if (streak >= maxRetries) {
    await refuse($, `${label}: gave up after ${streak} retries in a row. Type "continue" to try again.`)

    return
  }

  const attempt = streak + 1
  const delay = backoffMs(attempt)
  const now = await $.clock.now()
  await schedule($, rt, { kind: 'retry', attempt, maxRetries, dueAt: now + delay, label })
  await note($, `turn failed: ${label}; retry ${attempt}/${maxRetries} in ${countdown(delay)}`)
}

async function scheduleResume($: EngineInterface, rt: Runtime, verdict: Verdict): Promise<void> {
  const now = await $.clock.now()
  const dueAt = resumeAt((await $.session.usage()).rateLimits, now)

  if (dueAt === null) {
    // No window is used up: a short request rate limit, which a plain backoff handles.
    await scheduleRetry($, rt, 'rate limited')

    return
  }

  if (!rt.settings.resumeAfterLimit) {
    await refuse($, `${verdict.label}; resume after the reset is off (resumeAfterLimit).`)

    return
  }

  await schedule($, rt, { kind: 'resume', dueAt, label: verdict.label })
  await note($, `turn stopped: ${verdict.label}; resuming at reset in ${countdown(dueAt - now)}`)
}

async function decide($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.failedTurn === null) {
    return
  }

  rt.failedTurn = null
  rt.grace?.cancel()
  rt.grace = null
  const known = [rt.stopFailure?.details ?? '', rt.errorText].filter(text => text !== '').join('\n')
  const failure = { kind: rt.stopFailure?.kind, text: known === '' && rt.stopFailure === null ? rt.answer : known }
  rt.stopFailure = null
  rt.errorText = ''
  rt.answer = ''
  const verdict = classify(failure)

  if (!(await read($, isEnabledAtom))) {
    await note($, `turn failed: ${verdict.label}; keep-going is off`)

    return
  }

  if (verdict.kind === 'fatal') {
    await refuse($, `not retrying: ${verdict.label}.`)

    return
  }

  const total = await read($, totalAtom)

  if (total >= rt.settings.maxPerSession) {
    await refuse($, `${verdict.label}; not retrying, ${total} retries already sent this session (maxPerSession).`)

    return
  }

  if (verdict.kind === 'limit') {
    await scheduleResume($, rt, verdict)
  } else {
    await scheduleRetry($, rt, verdict.label)
  }
}

async function onTurnEnd($: EngineInterface, rt: Runtime, reason: TurnCompleteReason, turnId: string, answer: string): Promise<void> {
  rt.isTurnRunning = false

  if (reason === 'answer') {
    if ((await read($, streakAtom)) > 0) {
      await update($, streakAtom, () => 0)
      await note($, 'turn succeeded; retry count reset')
    }

    await cancelPending($, rt, 'a later turn succeeded')

    return
  }

  if (reason !== 'error') {
    // 'aborted' is the person pressing Esc, 'refusal' is the model's answer: neither is retried.
    return
  }

  rt.failedTurn = turnId
  rt.answer = answer

  if (rt.stopFailure !== null || rt.errorText !== '') {
    await decide($, rt)

    return
  }

  rt.grace = $.clock.after(DETAILS_GRACE_MS, () => {
    void decide($, rt)
  })
}

async function personTookOver($: EngineInterface, rt: Runtime): Promise<void> {
  await cancelPending($, rt, 'you sent a prompt')
  await update($, streakAtom, () => 0)
}

async function runCommand($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const action = parseCommand(args)

  if (action === null) {
    return 'Usage: /keep-going [on|off|cancel]'
  }

  if (action === 'on') {
    await update($, isEnabledAtom, () => true)

    return 'keep-going is on.'
  }

  if (action === 'off') {
    await update($, isEnabledAtom, () => false)
    await cancelPending($, rt, 'turned off')

    return 'keep-going is off: failed turns stay failed until you turn it back on.'
  }

  if (action === 'cancel') {
    const was = await read($, pendingAtom)
    await cancelPending($, rt, '/keep-going cancel')

    return was === null ? 'Nothing was pending.' : `Cancelled the pending ${was.kind}.`
  }

  const snapshot = {
    isEnabled: await read($, isEnabledAtom),
    pending: await read($, pendingAtom),
    streak: await read($, streakAtom),
    total: await read($, totalAtom),
    history: await read($, historyAtom),
  }

  return report(snapshot, rt.settings, await $.clock.now())
}

export const register: Register = (on, options) => {
  const rt: Runtime = {
    settings: parseSettings(options),
    timer: null,
    ticker: null,
    grace: null,
    isTurnRunning: false,
    failedTurn: null,
    stopFailure: null,
    errorText: '',
    answer: '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show retry state and history; /keep-going on|off|cancel' })
    // A pending retry in state with no timer behind it is left over from before a hot reload.
    await cancelPending($, rt, 'the module reloaded')

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await cancelPending($, rt, 'the session ended')

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    rt.isTurnRunning = true
    rt.stopFailure = null
    rt.errorText = ''

    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const text = e.agentId === undefined ? engineRowText(e.message.type, e.origin, e.message.content) : null

    if (text !== null) {
      rt.errorText = text
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined) {
      rt.stopFailure = { kind: e.error, details: e.error_details ?? '' }
      await decide($, rt)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      await onTurnEnd($, rt, e.reason, e.turnId, e.answer)
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // origin is stamped by the engine; a submission without one is not attributable to the person.
    const origin: PromptOrigin | undefined = e.origin

    if (origin !== undefined && isPerson(origin.kind) && !isOwnCommand(e.text)) {
      await personTookOver($, rt)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runCommand($, rt, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (rt.settings.display !== 'band' || e.props.hasSurvey) {
      return next(e)
    }

    const pending = await read($, pendingAtom)

    if (pending === null) {
      return next(e)
    }

    await read($, tickAtom)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="yellow" wrap="truncate">
          {pendingLine(pending, now)}{' '}
        </Text>
        <Button key="cancel" label="cancel" onPress={() => cancelPending($, rt, 'cancel pressed')} />
      </Box>
    )
  })
}
