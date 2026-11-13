import type { HubDeps, HubReply, HubRequest } from './service'
import { json } from '@sveltejs/kit'
import { HUB_ERROR_STATUS, HubError } from './errors'

/**
 * Shared plumbing for /api/hub/*: machine endpoints, called by other installs
 * without a session — authenticated by their signature (service.ts), never by
 * a cookie. While the contribute-hub module is off they answer 404 and do
 * nothing else (fail loud: this install is not a central board). HubError →
 * its status; anything else is a logged 500.
 */

export type HubRuntime = {
  active: () => Promise<boolean>
  deps: () => Promise<HubDeps>
}

export const liveHubRuntime: HubRuntime = {
  active: async () => (await import('./live')).contributeHubActive(),
  deps: async () => (await import('./live')).contributeHubDeps(),
}

export async function hubRoute(
  runtime: HubRuntime,
  request: Request,
  url: URL,
  run: (deps: HubDeps, req: HubRequest) => Promise<HubReply>,
): Promise<Response> {
  if (!(await runtime.active())) return json({ error: 'Not found', code: 'not_found' }, { status: 404 })
  try {
    // The raw body, read once: the signature covers exactly these bytes, and the same string is parsed.
    const body = await request.text()
    const out = await run(await runtime.deps(), { method: request.method, path: url.pathname, headers: request.headers, body })
    return json(out.body, { status: out.status })
  } catch (err) {
    if (err instanceof HubError) return json({ error: err.message, code: err.code }, { status: HUB_ERROR_STATUS[err.code] })
    console.error('[contribute-hub] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
