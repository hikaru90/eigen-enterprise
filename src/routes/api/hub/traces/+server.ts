import type { RequestHandler } from './$types'
import { liveTraceHubRuntime, traceHubRoute } from '$lib/server/traces/hub-route'
import { ingestTraces, withdrawAll } from '../../../../../modules/traces/hub/service'

/**
 * POST /api/hub/traces — a box sends one batch of Tier A spans (plan/traces-phone-home.md T3);
 * idempotent by batch id. DELETE withdraws everything the signing box sent. No session: signed
 * by the install. 404 while the trace-hub module is off.
 */

/** Overridable in tests. */
export const _deps = { runtime: liveTraceHubRuntime }

export const POST: RequestHandler = ({ request, url }) => traceHubRoute(_deps.runtime, request, url, (deps, req) => ingestTraces(deps, req))

export const DELETE: RequestHandler = ({ request, url }) => traceHubRoute(_deps.runtime, request, url, (deps, req) => withdrawAll(deps, req))
