import type { HubReply, HubRequest } from '../contribute/hub/service'
import type { HubBinaryReply, ModuleHubDeps } from './service'
import { json } from '@sveltejs/kit'
import { HUB_ERROR_STATUS, HubError } from '../contribute/hub/errors'

/**
 * Shared plumbing for /api/hub/modules/*: machine endpoints called by other
 * installs without a session, authenticated by their signature (service.ts).
 * While the module-hub module is off they answer 404 and do nothing else
 * (fail loud: this install is not the module hub). HubError → its status;
 * anything else is a logged 500.
 */

export type ModuleHubRuntime = {
  active: () => Promise<boolean>
  deps: () => Promise<ModuleHubDeps>
}

export const liveModuleHubRuntime: ModuleHubRuntime = {
  active: async () => (await import('./live')).moduleHubActive(),
  deps: async () => (await import('./live')).moduleHubDeps(),
}

export async function moduleHubRoute(
  runtime: ModuleHubRuntime,
  request: Request,
  url: URL,
  run: (deps: ModuleHubDeps, req: HubRequest) => Promise<HubReply | HubBinaryReply>,
): Promise<Response> {
  if (!(await runtime.active())) return json({ error: 'Not found', code: 'not_found' }, { status: 404 })
  try {
    // The raw body, read once: the signature covers exactly these bytes, and the same string is parsed.
    const body = await request.text()
    const out = await run(await runtime.deps(), { method: request.method, path: url.pathname, headers: request.headers, body })
    if ('bytes' in out) {
      return new Response(new Uint8Array(out.bytes), { status: out.status, headers: { 'content-type': out.contentType, 'content-length': String(out.bytes.byteLength) } })
    }
    return json(out.body, { status: out.status })
  } catch (err) {
    if (err instanceof HubError) return json({ error: err.message, code: err.code }, { status: HUB_ERROR_STATUS[err.code] })
    console.error('[module-hub] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
