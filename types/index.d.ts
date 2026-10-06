/** A prompt keep-going will send when its timer fires. */
export type Pending =
  | { kind: 'retry'; attempt: number; maxRetries: number; dueAt: number; label: string }
  | { kind: 'resume'; dueAt: number; label: string }

export type HistoryEntry = { at: number; text: string }

declare module 'claude-code' {
  interface PluginState {
    'keep-going': {
      pending: Pending | null
      /** Retries sent since the last successful turn or the last prompt you typed. */
      streak: number
      /** Retries and resumes sent this session. */
      total: number
      isEnabled: boolean
      history: HistoryEntry[]
      tick: number
    }
  }
}
