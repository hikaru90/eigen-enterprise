import { json } from '@sveltejs/kit'
import { errorReport, refusalReport } from '$lib/server/errors/report'

/**
 * JSON answers for the Memory / timeline API routes in the one error shape
 * (`{ error, agent }`, read in the browser by `$lib/memory/request-error`).
 * The sentence the person sees is the route's own; the agent half says what
 * was attempted, with which input.
 */
export type RouteContext = { attempted: string; tool?: string; input?: unknown }

/** A refusal that is not an exception (validation, signed out). */
export function refuse(status: number, sentence: string, ctx: RouteContext): Response {
  return json(refusalReport(sentence, ctx), { status })
}

/** A caught error; the person sees its message, as the routes always showed it. */
export function failed(status: number, err: unknown, ctx: RouteContext): Response {
  return json(
    errorReport(err, { ...ctx, plain: (e) => (e instanceof Error ? e.message : String(e)) }),
    { status },
  )
}
