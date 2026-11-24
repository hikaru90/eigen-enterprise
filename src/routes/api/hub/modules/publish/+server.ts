import type { RequestHandler } from './$types'
import { liveModuleHubRuntime, moduleHubRoute } from '../../../../../../modules/module-hub/http'
import { publishModule } from '../../../../../../modules/module-hub/service'

/**
 * POST /api/hub/modules/publish — an install publishes one module bundle and
 * gets the hub's signed receipt (plan/phase-upgrades-u2.md §6.2). No session:
 * signed by the install like a contribution. 404 while module-hub is off.
 */

/** Overridable in tests. */
export const _deps = { runtime: liveModuleHubRuntime }

export const POST: RequestHandler = ({ request, url }) => moduleHubRoute(_deps.runtime, request, url, (deps, req) => publishModule(deps, req))
