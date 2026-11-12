import { json } from '@sveltejs/kit'
import { pluginOffMessage, routeOwner, type PluginOff } from '$lib/plugins/routes'

/**
 * The plugin gate (owner, 2026-11-12: every sidebar entry is a plugin; a
 * switched-off plugin is off everywhere). One `handle` step in
 * src/hooks.server.ts runs it for every request, after sign-in is known and
 * before any route code runs:
 * - a route no plugin owns (the core, sign-in, the public site) passes;
 * - a switched-on plugin passes;
 * - a page of a switched-off plugin renders one clear page: the hook hands
 *   `pluginOff` to the (nucleus) layout load, which answers it as a 404 page
 *   ("<Plugin> is switched off", and for the owner/admins the way to Settings
 *   → Plugins). A form action posted to such a page never runs.
 * - an API of a switched-off plugin answers 409 { code: 'plugin_inactive' };
 * - a provider webhook gets its decided policy (drop / refuse / open — see
 *   $lib/plugins/routes), webhooks being called without a session.
 * Signed-out requests to pages and APIs pass: the route sends them to sign-in
 * (or answers 401) as always, and learns nothing about plugins.
 */

export type { PluginOff }

export type PluginGateDeps = {
  /** The activation set (cached in-process: the kernel's CachedActivationStore). */
  activations: () => Promise<Map<string, boolean>>
  /** The registered plugin's name; undefined = not registered (its routes answer as they do). */
  pluginName: (id: string) => Promise<string | undefined>
  /** Whether this person may switch plugins (Settings → Plugins). */
  canManage: (userId: string) => Promise<boolean>
  log: (line: string) => void
}

export type GateRequest = {
  pathname: string
  method: string
  /** SvelteKit's __data.json request of a client-side navigation. */
  isDataRequest: boolean
  headers: Headers
  userId: string | null
}

export type GateDecision =
  | { kind: 'pass' }
  /** Render the switched-off page (the (nucleus) layout load throws it). */
  | { kind: 'page'; off: PluginOff }
  | { kind: 'respond'; response: Response }

export const PLUGIN_INACTIVE = 'plugin_inactive'

/** The error every API of a switched-off plugin answers (and a refused webhook). */
export function pluginInactiveResponse(id: string, name: string): Response {
  return json(
    {
      error: `${name} is switched off. The owner or an admin can switch it on in Settings → Plugins.`,
      code: PLUGIN_INACTIVE,
      plugin: id,
    },
    { status: 409 },
  )
}

const wantsHtml = (headers: Headers) => (headers.get('accept') ?? '').includes('text/html')

export async function pluginGate(req: GateRequest, deps: PluginGateDeps): Promise<GateDecision> {
  const owner = routeOwner(req.pathname)
  if (!owner || owner.owner === 'core') return { kind: 'pass' }
  const webhook = owner.webhook
  if (webhook?.policy === 'open') return { kind: 'pass' }
  // Webhooks are called without a session; pages and APIs only gate a signed-in person.
  if (!webhook && !req.userId) return { kind: 'pass' }

  const name = await deps.pluginName(owner.plugin)
  if (name === undefined) return { kind: 'pass' }
  if ((await deps.activations()).get(owner.plugin) === true) return { kind: 'pass' }

  if (webhook) {
    deps.log(
      `[plugins] ${name} is switched off: ${webhook.policy === 'drop' ? 'dropped' : 'refused'} ${req.method} ${req.pathname} (${webhook.caller})`,
    )
    if (webhook.policy === 'refuse') return { kind: 'respond', response: pluginInactiveResponse(owner.plugin, name) }
    return { kind: 'respond', response: json({ ok: true, dropped: PLUGIN_INACTIVE }, { status: 200 }) }
  }

  if (owner.surface === 'api') return { kind: 'respond', response: pluginInactiveResponse(owner.plugin, name) }

  const userId = req.userId as string
  const off = async (): Promise<PluginOff> => ({ id: owner.plugin, name, canManage: await deps.canManage(userId) })
  const read = req.method === 'GET' || req.method === 'HEAD'
  if (read && (req.isDataRequest || wantsHtml(req.headers))) return { kind: 'page', off: await off() }
  if (!read && req.headers.get('x-sveltekit-action') === 'true') {
    // An enhanced form action: the client shows the error page (the same switched-off page).
    return {
      kind: 'respond',
      response: json(
        { type: 'error', status: 404, error: { message: pluginOffMessage(name), pluginOff: await off() } },
        { status: 404 },
      ),
    }
  }
  // A plain form post: back to the page (a GET), which shows the switched-off page.
  if (!read && wantsHtml(req.headers)) {
    return { kind: 'respond', response: new Response(null, { status: 303, headers: { location: req.pathname } }) }
  }
  // An endpoint under a page prefix (e.g. a deploy's progress stream): the API answer.
  return { kind: 'respond', response: pluginInactiveResponse(owner.plugin, name) }
}
