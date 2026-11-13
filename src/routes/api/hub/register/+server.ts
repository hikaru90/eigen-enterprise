import type { RequestHandler } from './$types'
import { hubRoute, liveHubRuntime } from '../../../../../modules/contribute-hub/http'
import { register } from '../../../../../modules/contribute-hub/service'

/**
 * POST /api/hub/register — an install registers its Ed25519 public key with
 * the central board (plan/contribute-phone-home.md §3). No session: any
 * install may register (owner, Q2), rate-limited per install id. 404 while
 * the contribute-hub module is off.
 */

/** Overridable in tests. */
export const _deps = { runtime: liveHubRuntime }

export const POST: RequestHandler = ({ request, url }) => hubRoute(_deps.runtime, request, url, (deps, req) => register(deps, req.body))
