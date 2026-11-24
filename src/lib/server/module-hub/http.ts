import type { HubBinaryReply, ModuleHubDeps, ModuleHubReply, ModuleHubRequest } from '../../../../modules/module-hub/service'
import { json } from '@sveltejs/kit'
import { HUB_ERROR_STATUS, HubError } from '../../../../modules/contribute/hub/errors'
import { MODULE_HUB_ERROR_STATUS, ModuleHubError } from '../../../../modules/module-hub/errors'

/**
 * Shared plumbing for /api/hub/modules/*: machine endpoints called by other
 * installs without a session, authenticated by their signature. This is where
 * the two hubs meet — outside both modules, so neither imports the other: the
 * module hub's deps get the contribute hub's `authenticate` (installs,
 * signature, revoked, replay guard, rate limit). While the module-hub module
 * is off the endpoints answer 404 and do nothing else (fail loud: this install
 * is not the module hub). HubError / ModuleHubError → their status; anything
 * else is a logged 500.
 */

export type ModuleHubRuntime = {
  active: () => Promise<boolean>
  deps: () => Promise<ModuleHubDeps>
}

export const liveModuleHubRuntime: ModuleHubRuntime = {
  active: async () => (await import('../../../../modules/module-hub/live')).moduleHubActive(),
  deps: async () => {
    const [{ moduleHubDeps }, { contributeHubDeps }, { authenticate }] = await Promise.all([
      import('../../../../modules/module-hub/live'),
      import('../../../../modules/contribute/hub/live'),
      import('../../../../modules/contribute/hub/service'),
    ])
    const [parts, hub] = await Promise.all([moduleHubDeps(), contributeHubDeps()])
    return { ...parts, authenticate: (req) => authenticate(hub, req) }
  },
}

export async function moduleHubRoute(
  runtime: ModuleHubRuntime,
  request: Request,
  url: URL,
  run: (deps: ModuleHubDeps, req: ModuleHubRequest) => Promise<ModuleHubReply | HubBinaryReply>,
): Promise<Response> {
  if (!(await runtime.active())) return json({ error: 'Not found', code: 'not_found' }, { status: 404 })
  try {
    // The raw body, read once: the signature covers exactly these bytes, and the same string is parsed.
    const body = await request.text()
    const out = await run(await runtime.deps(), { method: request.method, path: url.pathname, headers: request.headers, body })
    if ('bytes' in out) {
      return new Response(new Uint8Array(out.bytes), {
        status: out.status,
        headers: { 'content-type': out.contentType, 'content-length': String(out.bytes.byteLength) },
      })
    }
    return json(out.body, { status: out.status })
  } catch (err) {
    if (err instanceof HubError) return json({ error: err.message, code: err.code }, { status: HUB_ERROR_STATUS[err.code] })
    if (err instanceof ModuleHubError) return json({ error: err.message, code: err.code }, { status: MODULE_HUB_ERROR_STATUS[err.code] })
    console.error('[module-hub] request failed', err)
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
