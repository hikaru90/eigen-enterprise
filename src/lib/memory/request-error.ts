import { shownErrorOf, type AgentReport, type ShownError } from '$lib/errors/agent-report'

/**
 * The browser side of a refused Memory / timeline API request (the one error
 * shape, `$lib/errors/agent-report`): the routes answer `{ error, agent }`; an
 * unexpected failure comes back from `handleError` as `{ message, agent }`.
 * The page throws a `RequestError` and shows its `shown` with `<ErrorNotice>`.
 */
export class RequestError extends Error {
  constructor(readonly shown: ShownError) {
    super(shown.error)
    this.name = 'RequestError'
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The agent report in a failed response's body text, when the server sent one. */
export function agentIn(text: string): AgentReport | null {
  return shownErrorOf(parsed(text))?.agent ?? null
}

/** The error a failed response carries; a non-JSON body is the sentence itself. */
export async function requestErrorOf(res: Response): Promise<RequestError> {
  const text = await res.text()
  const body = parsed(text)
  const shown =
    shownErrorOf(body) ??
    (body && typeof body === 'object' && 'message' in body
      ? shownErrorOf({ error: body.message, agent: (body as { agent?: unknown }).agent })
      : null)
  return new RequestError(shown ?? { error: text || `Request failed (${res.status})`, agent: null })
}

/** Any caught error as the page shows it. */
export function shownOf(err: unknown): ShownError {
  if (err instanceof RequestError) return err.shown
  return { error: err instanceof Error ? err.message : String(err), agent: null }
}
