import type { RequestHandler } from './$types'
import { liveModuleHubRuntime, moduleHubRoute } from '$lib/server/module-hub/http'
import { fetchModuleBundle } from '../../../../../../../modules/module-hub/service'

/**
 * GET /api/hub/modules/bundles/:sha256 — the bytes of a published bundle, for
 * a box restoring a module it no longer holds (plan/phase-upgrades-u2.md §3).
 * Signed by the install. 404 while module-hub is off.
 */

/** Overridable in tests. */
export const _deps = { runtime: liveModuleHubRuntime }

export const GET: RequestHandler = ({ request, url, params }) =>
  moduleHubRoute(_deps.runtime, request, url, (deps, req) => fetchModuleBundle(deps, req, params.sha256))
