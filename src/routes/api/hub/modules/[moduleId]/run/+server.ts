import type { RequestHandler } from './$types'
import { liveModuleHubRuntime, moduleHubRoute } from '$lib/server/module-hub/http'
import { reportModuleRun } from '../../../../../../../modules/module-hub/service'

/**
 * PUT /api/hub/modules/:moduleId/run — an install reports the run state of
 * the release it runs; the answer lists which installs run the module
 * (plan/phase-upgrades-u2.md §6.2). Signed by the install. 404 while
 * module-hub is off.
 */

/** Overridable in tests. */
export const _deps = { runtime: liveModuleHubRuntime }

export const PUT: RequestHandler = ({ request, url, params }) =>
  moduleHubRoute(_deps.runtime, request, url, (deps, req) => reportModuleRun(deps, req, params.moduleId))
