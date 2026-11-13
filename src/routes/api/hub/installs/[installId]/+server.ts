import type { RequestHandler } from './$types'
import { hubRoute, liveHubRuntime } from '../../../../../../modules/contribute-hub/http'
import { deleteInstall } from '../../../../../../modules/contribute-hub/service'

/**
 * DELETE /api/hub/installs/:installId — an install withdraws everything it
 * shared (sharing switched off with deletion). Only its own: signed by it.
 * 404 while the contribute-hub module is off.
 */

/** Overridable in tests. */
export const _deps = { runtime: liveHubRuntime }

export const DELETE: RequestHandler = ({ request, url, params }) =>
  hubRoute(_deps.runtime, request, url, (deps, req) => deleteInstall(deps, req, params.installId))
