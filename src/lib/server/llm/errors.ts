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
 * The upstream provider stopped a reply with finish_reason "length" before the
 * max_tokens we asked for: its own limit (e.g. a small context window on one of
 * the providers a router picked), not our budget. The reply is incomplete, so the
 * gateway client retries it like a failed call instead of handing half an answer on.
 */
export class LlmCutShortError extends Error {
  constructor(completionTokens: number, maxTokens: number) {
    super(
      `LLM provider cut the reply short at ${completionTokens} of ${maxTokens} tokens (finish_reason length below max_tokens)`,
    )
    this.name = 'LlmCutShortError'
  }
}

export function isLlmCutShortError(e: unknown): boolean {
  return inCauseChain(e, LlmCutShortError)
}

/** What a person reads when the provider cut every attempt of a reply short (wish 377f4843). */
export const LLM_CUT_SHORT_MESSAGE =
  'The AI provider stopped my answer partway, on every try, so I have no complete answer. Send the message again in a minute; if it keeps happening, ask for a shorter answer — the team has the details.'

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

/** Walks the error's cause chain (bounded) looking for an instance of `type`. */
function inCauseChain(e: unknown, type: abstract new (...args: never[]) => Error): boolean {
  let current: unknown = e
  let guard = 0
  while (current && guard < 8) {
    guard += 1
    if (current instanceof type) return true
    if (typeof current === 'object' && 'cause' in current) {
      current = (current as { cause?: unknown }).cause
      continue
    }
    break
  }
  return false
}

/** Walks the error's cause chain (bounded) looking for LlmNotConfiguredError. */
export function isLlmNotConfiguredError(e: unknown): boolean {
  return inCauseChain(e, LlmNotConfiguredError)
}

/** What a member over the company's daily AI cap reads (chat and every other surface). */
export const LLM_DAILY_CAP_MESSAGE =
  "You've used today's AI allowance for this company. It resets at midnight UTC."

/** What a login-free demo visitor reads once their network's daily AI calls are spent. */
export function demoGuestAiLimitMessage(limit: number): string {
  if (limit <= 0) {
    return 'AI calls are turned off in the live demo. Sign up or self-host eigenEnterprise to try the AI assistant.'
  }
  return `You've used your ${limit} demo AI ${limit === 1 ? 'call' : 'calls'} for today. Sign up or self-host eigenEnterprise to keep going.`
}

/**
 * The person's model calls today reached the company's per-person daily AI cap
 * (plan/phase-demo-company.md D2) or the demo visitor's per-IP AI call limit:
 * the gateway refuses before any provider call. Typed so chat and features show
 * the plain message without message matching.
 */
export class LlmDailyCapError extends Error {
  readonly capUsd: number
  readonly spentUsd: number

  constructor(input: { capUsd: number; spentUsd: number; message?: string }) {
    super(input.message ?? LLM_DAILY_CAP_MESSAGE)
    this.name = 'LlmDailyCapError'
    this.capUsd = input.capUsd
    this.spentUsd = input.spentUsd
  }
}

/** Walks the error's cause chain (bounded) looking for LlmDailyCapError. */
export function isLlmDailyCapError(e: unknown): boolean {
  return inCauseChain(e, LlmDailyCapError)
}

/** Returns the first LlmDailyCapError's human message in the cause chain, or null. */
export function dailyCapErrorMessage(e: unknown): string | null {
  let current: unknown = e
  let guard = 0
  while (current && guard < 8) {
    guard += 1
    if (current instanceof LlmDailyCapError) return current.message
    if (typeof current === 'object' && 'cause' in current) {
      current = (current as { cause?: unknown }).cause
      continue
    }
    break
  }
  return null
}
