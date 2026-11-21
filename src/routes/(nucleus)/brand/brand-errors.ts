import { shownErrorOf, type ShownError } from '$lib/errors/agent-report'

/**
 * The brand pages' failed requests in the one error shape: the server's
 * `{ error, agent }` when it sent one (kernel tool refusals, see
 * src/routes/api/brand/handler.ts), else what the page saw — the status and
 * the start of the answer, as before.
 */
export class BrandRequestError extends Error {
  constructor(readonly shown: ShownError) {
    super(shown.error)
    this.name = 'BrandRequestError'
  }
}

/** A failed answer (its status and body text) as a BrandRequestError. */
export function brandRequestError(status: number, text: string, what: string): BrandRequestError {
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON (a proxy or SvelteKit text page): the text itself is shown below.
  }
  return new BrandRequestError(
    shownErrorOf(body) ?? {
      error: `${what} failed (${status}): ${text.slice(0, 400)}`,
      agent: null,
    },
  )
}

/** Any caught failure as a page shows it. */
export function brandShownError(err: unknown): ShownError {
  if (err instanceof BrandRequestError) return err.shown
  return { error: err instanceof Error ? err.message : String(err), agent: null }
}
