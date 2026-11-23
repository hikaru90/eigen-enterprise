import type { RequestEvent } from '@sveltejs/kit'

type RequestStore = { event: RequestEvent; state: Record<string, unknown> }
type KitInternalServer = { with_request_store<T>(store: RequestStore | null, fn: () => T): T }

/**
 * Run a server-side sign-in outside an HTTP request. Better Auth's SvelteKit
 * cookie plugin (src/lib/server/auth.ts) hands the new session cookie to the
 * current request event; a script has no request, so it gets one whose
 * cookies go nowhere — there is no browser to keep them. Everything else (the
 * user-create hook, the invite it consumes, the role it takes) runs unchanged.
 */
export async function withoutBrowser<T>(fn: () => Promise<T>): Promise<T> {
  // SvelteKit's own request store (the one `getRequestEvent` from `$app/server` reads).
  // @ts-expect-error -- kit ships no types for this internal entry; KitInternalServer describes the one function used.
  const kit = (await import('@sveltejs/kit/internal/server')) as unknown as KitInternalServer
  const event = {
    cookies: {
      set: () => {},
      get: () => undefined,
      getAll: () => [],
      delete: () => {},
      serialize: () => '',
    },
  } as unknown as RequestEvent
  return kit.with_request_store({ event, state: {} }, fn)
}
