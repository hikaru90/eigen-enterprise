import type { RequestHandler } from './$types'
import { hubRoute, liveHubRuntime } from '../../../../../../modules/contribute/hub/http'
import { deleteContribution, upsertContribution } from '../../../../../../modules/contribute/hub/service'

/**
 * PUT /api/hub/contributions/:remoteId — an install shares (or updates) one
 * proposal; idempotent. DELETE withdraws it. No session: signed by the
 * install (modules/contribute/share/contract.ts). 404 while the
 * contribute-hub module is off.
 */

/** Overridable in tests. */
export const _deps = { runtime: liveHubRuntime }

export const PUT: RequestHandler = ({ request, url, params }) =>
  hubRoute(_deps.runtime, request, url, (deps, req) => upsertContribution(deps, req, params.remoteId))

export const DELETE: RequestHandler = ({ request, url, params }) =>
  hubRoute(_deps.runtime, request, url, (deps, req) => deleteContribution(deps, req, params.remoteId))
