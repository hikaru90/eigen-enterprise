import { shownErrorOf, type ShownError } from '$lib/errors/agent-report'

/**
 * A failed Drive (or office) call as a page shows it: the error's sentence
 * and, when the server sent one, its agent report (`DriveApiError.agent`);
 * a browser-side failure (fetch threw, a parser failed) has no report. Read
 * by structure, so it works for any error the call sites see.
 */
export function driveShownError(err: unknown): ShownError {
  const error = err instanceof Error ? err.message : String(err)
  const agent =
    err && typeof err === 'object' && 'agent' in err ? (err as { agent: unknown }).agent : null
  return shownErrorOf({ error, agent }) ?? { error, agent: null }
}
