import type { Handle } from '@sveltejs/kit'
import { deLocalizeUrl } from '$lib/paraglide/runtime'
import { pluginGate, type PluginGateDeps } from './gate'

/**
 * The plugin gate as a `handle` step (src/hooks.server.ts, after sign-in is
 * known). An answer the gate gives (an API's 409, a webhook's drop/refusal,
 * a refused form action) is returned before any route code runs; a page of a
 * switched-off plugin resolves with `locals.pluginOff` set, and the (nucleus)
 * layout load renders it as the switched-off page.
 */
export function pluginHandle(deps: PluginGateDeps): Handle {
  return async ({ event, resolve }) => {
    const decision = await pluginGate(
      {
        // The path the router matches (src/hooks.ts reroute).
        pathname: deLocalizeUrl(event.url).pathname,
        method: event.request.method,
        isDataRequest: event.isDataRequest,
        headers: event.request.headers,
        userId: event.locals.user?.id ?? null,
      },
      deps,
    )
    if (decision.kind === 'respond') return decision.response
    if (decision.kind === 'page') event.locals.pluginOff = decision.off
    return resolve(event)
  }
}
