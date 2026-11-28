import type { RequestHandler } from './$types'
import { liveTraceHubRuntime, traceHubRoute } from '$lib/server/traces/hub-route'
import { withdrawBatch } from '../../../../../../modules/traces/hub/service'

/** DELETE /api/hub/traces/:batchId — a box withdraws one batch it sent. Signed; 404 while trace-hub is off. */

/** Overridable in tests. */
export const _deps = { runtime: liveTraceHubRuntime }

export const DELETE: RequestHandler = ({ request, url, params }) =>
  traceHubRoute(_deps.runtime, request, url, (deps, req) => withdrawBatch(deps, req, params.batchId))
