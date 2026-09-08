/**
 * Typed LLM gateway HTTP failure. Carries the numeric status so callers (ingest retry
 * budget, temporal degradation) classify fatal vs transient WITHOUT message string
 * matching. The message keeps the legacy `LLM HTTP <status>: …` format for log continuity.
 */
export class LlmHttpError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(`LLM HTTP ${status}: ${detail}`)
    this.name = 'LlmHttpError'
    this.status = status
  }
}

export function isLlmHttpError(e: unknown): e is LlmHttpError {
  return e instanceof LlmHttpError
}

/**
 * Missing/incomplete LLM gateway configuration (no base URL, no API key, no routing
 * rule/model). Thrown typed so user-facing surfaces (chat error terminal payload,
 * onboarding) can offer the provider-setup flow WITHOUT message string matching.
 * The messages stay operator-actionable (name the env var or settings surface).
 */
export class LlmNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmNotConfiguredError'
  }
}

/** Walks the error's cause chain (bounded) looking for LlmNotConfiguredError. */
export function isLlmNotConfiguredError(e: unknown): boolean {
  let current: unknown = e
  let guard = 0
  while (current && guard < 8) {
    guard += 1
    if (current instanceof LlmNotConfiguredError) return true
    if (typeof current === 'object' && 'cause' in current) {
      current = (current as { cause?: unknown }).cause
      continue
    }
    break
  }
  return false
}
