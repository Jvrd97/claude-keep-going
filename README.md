# keep-going

A Claude Code mod that retries a turn that died on a transient API error and resumes the work when your usage limit resets, so a long session does not wait for someone to type "continue".

```
keep-going: retry 2/4 in 0:45 [ cancel ]
keep-going: resuming at reset in 1h 12m [ cancel ]
keep-going: not retrying: authentication failed.
```

## Why

Long sessions die on errors that would have passed a minute later, and the work then sits until a person comes back:

- The 2026 wave of API errors: [#46987](https://github.com/anthropics/claude-code/issues/46987), [#62123](https://github.com/anthropics/claude-code/issues/62123) and [#69238](https://github.com/anthropics/claude-code/issues/69238), about 1.9k 👍 and 2.3k comments across the group. Stream idle timeouts, 529 overloaded, 500s and connection resets end the turn, and someone has to type "continue".
- Reddit: ["API Error: 500 again"](https://www.reddit.com/r/ClaudeCode/comments/1sm867b/), at least 990 upvotes.
- Auto-continue after the limit reset: [#13354](https://github.com/anthropics/claude-code/issues/13354), 311 👍. When the 5-hour window runs out at night, nothing resumes the task at the reset.

Claude Code already retries a single request several times. keep-going works one level up: when the whole turn has failed, it waits and asks the model to continue from where it stopped.

## What it does

| Turn ended with | keep-going does |
|---|---|
| 5xx, 529 overloaded, a timeout, stream idle timeout, connection reset (`ECONN*`), "tool call could not be parsed" | Retries after 30s, 60s, 120s, 240s, at most `maxRetries` in a row |
| Usage limit, with a used-up 5h or 7d window | Resumes one minute after that window resets |
| 429 with no used-up window (a short request rate limit) | Retries with the same backoff |
| Auth failure, billing, 400 invalid request, context too long, an error it cannot name | Nothing; a toast says why |
| You pressed Esc, or the model refused | Nothing |

The retry prompt is: "The previous request failed with a transient API error (overloaded (529)). Continue the task from where you stopped; do not repeat finished steps." The resume prompt says the same about the limit reset.

While a retry or resume is pending:

- The band above the prompt counts down and has a `cancel` button (or the status line shows the countdown, see `display`).
- Anything you type cancels it and resets the count. `/keep-going` itself does not.
- A successful turn resets the count and drops anything pending.

`/keep-going` prints the state and this session's history. `/keep-going off`, `on` and `cancel` do what they say.

## Install

You need Claude Code with mods (function hooks). It was tested on 2.1.285; the smoke run also passed on 2.1.291.

From the marketplace in this repo:

```
/plugin marketplace add Jvrd97/claude-keep-going
/plugin install keep-going@keep-going
```

Or straight from disk, for one session:

```bash
git clone https://github.com/Jvrd97/claude-keep-going.git
claude --plugin-dir ./claude-keep-going
```

## Settings

Change them in `/config` under the plugin, or in `settings.json` under `pluginConfigs`:

| Field | Default | Meaning |
|---|---|---|
| `maxRetries` | `4` | Retries in a row after transient errors. `0` turns retries off |
| `maxPerSession` | `20` | Hard cap on retries and resumes sent in one session |
| `resumeAfterLimit` | `true` | Resume one minute after a used-up window resets |
| `display` | `band` | `band` draws the countdown with a cancel button above the prompt; `status` writes it to the status line |

## How it works

- `classic.StopFailure` gives the error kind the engine assigned (`server_error`, `rate_limit`, `authentication_failed`, ...). `session.append` gives the text of the error row the engine writes in the model's place ("API Error: 529 ..."); only rows stamped with the engine's `<synthetic>` model are read, never the model's own words. The two can arrive in either order, so the verdict waits up to 2 seconds for them, and falls back to the turn's final text.
- `turn.complete` with `reason: 'error'` on the main loop starts the decision. Subagent turns, `aborted` and `refusal` are ignored.
- The retry is a prompt queued with `$.prompt.submit`. The model sees it as a message from the keep-going plugin, and the transcript names the plugin.
- `$.clock.after` holds the timer. When it fires while another turn is running, it checks again every 5 seconds and sends only once the session is idle.
- `prompt.submit` from the composer, the Remote Control bridge or the SDK host counts as you typing. Prompts from plugins, notifications and peers do not.
- The resume time comes from `$.session.usage()`: the latest `resetsAt` among windows at 100%, plus 60 seconds.
- State (pending retry, counters, history of the last 50 events) lives in the session's `$.state`. The mod writes no files and makes no network calls.

What it cannot do:

- It cannot produce a real API error on demand, so the retry path is covered by tests with a mocked clock, not by a live failure. The fatal path was seen live: an expired OAuth session was classified as "authentication failed" and not retried.
- A hot reload of the module, `/clear` and the end of the session cancel a pending retry: the engine drops the module's timers with the old module, and the history records it. A `claude -p` run ends with its turn, so it never waits for a retry.
- It reads windows from the last API response. If no window shows 100% when a limit error arrives, it treats the error as a short rate limit and retries with backoff instead of waiting for the reset.
- The classification is pattern matching on the error kind and text. An error worded in a way it does not know is treated as fatal and only toasted, which is the safe side.
- A retry continues the conversation as it stands. If the failure cut a tool call in half, the model sees that and decides what to redo; the prompt asks it not to repeat finished steps, but it is still the model's call.

## Develop

Inside Claude Code run `/plugin-types .claude/types` once: it writes the API types `tsc` reads. Then:

```bash
tsc -p .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
```

## По-русски

Мод повторяет ход, который упал на временной ошибке API (500, 529 overloaded, таймаут, обрыв соединения), чтобы никому не приходилось писать «continue».

- Повторы идут с паузой 30, 60, 120 и 240 секунд, не больше `maxRetries` подряд и `maxPerSession` за сессию.
- Если кончился 5-часовой или недельный лимит, мод продолжает работу через минуту после сброса окна.
- Ошибки авторизации, неверный запрос и переполненный контекст не повторяются: приходит уведомление с причиной.
- Над полем ввода идёт обратный отсчёт с кнопкой отмены. Любой ваш ввод отменяет повтор.

`/keep-going` показывает состояние и историю, `/keep-going off|on|cancel` управляет модом. Мод ничего не отправляет в сеть и не пишет файлы.

## License

MIT
