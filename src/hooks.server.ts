import type { AppUser } from './app.d.ts'
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit'
import { reportSpeechModelsAtStartup } from '$lib/server/llm/speech-models'
import { sequence } from '@sveltejs/kit/hooks'
import { svelteKitHandler } from 'better-auth/svelte-kit'
import { building, dev } from '$app/environment'
import { getTextDirection } from '$lib/paraglide/runtime'
import { paraglideMiddleware } from '$lib/paraglide/server'
import { captureServerException } from '$lib/server/analytics/posthog-server'
import { hashApiKey } from '$lib/server/api-keys/api-key-utils'
import { isApiKeyRoute, parseBearerApiKey } from '$lib/server/api-keys/bearer-routes'
import { auth } from '$lib/server/auth'
import { bootApp } from '$lib/server/boot'
import {
  appSql,
  appDbAsyncLocal,
  createScopedDrizzle,
  activateTenantDbSession,
  deactivateTenantDbSession,
} from '$lib/server/db'
import { authSql } from '$lib/server/db/auth-db'
import { tenantUserAsyncLocal } from '$lib/server/db/tenant-context'
import { startJobQueueTicker } from '$lib/server/job-queue/ticker'
import { startNotificationDispatchTicker } from '$lib/server/memory/notification-dispatch-ticker'
import { startBackupHealthTicker } from '$lib/server/backups/live'
import { logOpsStartupDiagnostics } from '$lib/server/ops/startup-diagnostics'
import { configuredMailTransport } from '../modules/email/owlery/service'
import { installPromptShutdown } from '$lib/server/shutdown'
import { csrfRefusal, isForbiddenCrossSiteForm } from '$lib/server/csrf'
import { releaseDurableHarnessLockForExit } from '$lib/server/agent/durable-harness'

if (!building) {
  // SIGTERM exits promptly; in-flight agent turns resume on reopen (D3).
  installPromptShutdown({ beforeExit: releaseDurableHarnessLockForExit })
  // Fail loud at boot on a bad MAIL_TRANSPORT (unknown value, or `fake` in
  // production without MAIL_TRANSPORT_FAKE_IN_PRODUCTION=1).
  if (configuredMailTransport() === 'fake') {
    console.warn('[mail] MAIL_TRANSPORT=fake: no email leaves this server; mails are captured in mail_fake_sent')
  }
  logOpsStartupDiagnostics()
  startJobQueueTicker()
  startNotificationDispatchTicker()
  // Backups (plan/phase-backups.md): mirror ee's runs into kernel_events, alert the owner on a failed/missing night.
  startBackupHealthTicker()
  // Composition root: kernel → orchestrator → chat gateway. bootApp memoizes,
  // so repeated hook loads boot once per process; a failed boot logs and fails
  // loud (unhandled rejection) — the memo is cleared so the next call retries.
  bootApp().catch((err) => {
    console.error('[boot]', err)
    throw err
  })
}

/**
 * SvelteKit's cross-site form check, run here (svelte.config.js disables the
 * built-in one) so Amazon SNS can post to /api/mail/ses-events — see
 * $lib/server/csrf. Like SvelteKit's, it is off in dev mode.
 */
const handleCsrf: Handle = ({ event, resolve }) => {
  if (!dev && isForbiddenCrossSiteForm(event.request, event.url)) return csrfRefusal(event.request)
  return resolve(event)
}

const handleParaglide: Handle = ({ event, resolve }) =>
  paraglideMiddleware(event.request, ({ request, locale }) => {
    event.request = request

    return resolve(event, {
      transformPageChunk: ({ html }) =>
        html
          .replace('%paraglide.lang%', locale)
          .replace('%paraglide.dir%', getTextDirection(locale)),
    })
  })

/**
 * Serve OAuth 2.0 discovery documents required by MCP clients.
 * We don't run a real OAuth server — we advertise Bearer-token-only auth
 * so clients that already have an API key skip the OAuth dance entirely.
 */
const handleWellKnown: Handle = async ({ event, resolve }) => {
  const { pathname } = new URL(event.request.url)
  const origin = new URL(event.request.url).origin

  // Both path-specific (/api/mcp) and root variants are handled
  if (
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/oauth-protected-resource/api/mcp'
  ) {
    return new Response(
      JSON.stringify({
        resource: `${origin}/api/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        resource_name: 'Eigen Memory MCP',
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }

  if (pathname === '/.well-known/oauth-authorization-server') {
    return new Response(
      JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/login`,
        token_endpoint: `${origin}/api/auth/token`,
        response_types_supported: ['token'],
        grant_types_supported: ['urn:ietf:params:oauth:grant-type:api-key'],
        token_endpoint_auth_methods_supported: ['none'],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }

  return resolve(event)
}

const handleBetterAuth: Handle = async ({ event, resolve }) => {
  const session = await auth.api.getSession({ headers: event.request.headers })

  if (session) {
    event.locals.session = session.session
    event.locals.user = session.user
  }

  // API key auth. A key authenticates only on the routes built for keys
  // (API_KEY_ROUTES); everywhere else the header is ignored and the request
  // stays anonymous. Decided here rather than per route because
  // resolveWithAppDb activates the tenant DB session from locals.user before
  // any route runs.
  if (!event.locals.user && isApiKeyRoute(event.url.pathname)) {
    const rawKey = parseBearerApiKey(event.request.headers.get('authorization'))
    if (rawKey) {
      const hash = hashApiKey(rawKey)
      const rows = await authSql<Array<{ id: string; user_id: string; key_name: string }>>`
				SELECT id, user_id, key_name FROM public.resolve_user_api_key(${hash})
			`
      if (rows.length > 0) {
        const row = rows[0]
        authSql`SELECT touch_user_api_key(${row.id}::uuid)`.catch(() => {
          /* non-critical */
        })
        event.locals.apiKeyAuth = { id: row.id, name: row.key_name }
        event.locals.user = {
          id: row.user_id,
          email: '',
          name: '',
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          image: null,
        } satisfies AppUser
      }
    }
  }

  const resolveWithAppDb: typeof resolve = async (opts) => {
    if (building) {
      return resolve(opts)
    }

    const reserved = await appSql.reserve()
    try {
      const uid = event.locals.user?.id ?? ''
      await activateTenantDbSession(reserved, uid)
      const scopedDb = createScopedDrizzle(reserved)
      const run = () => appDbAsyncLocal.run(scopedDb, () => resolve(opts))
      return uid ? await tenantUserAsyncLocal.run(uid, run) : await run()
    } finally {
      await deactivateTenantDbSession(reserved).catch(() => {})
      await reserved.release()
    }
  }

  return svelteKitHandler({ event, resolve: resolveWithAppDb, auth, building })
}

/** COOP only — do not set COEP `require-corp` globally; it blocks third-party scripts (e.g. PayPal SDK). */
const handleCrossOriginOpenerPolicy: Handle = async ({ event, resolve }) => {
  const response = await resolve(event)
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  return response
}

const handlePostHogProxy: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url

  if (pathname.startsWith('/ingest')) {
    const useAssetHost =
      pathname.startsWith('/ingest/static/') || pathname.startsWith('/ingest/array/')
    const hostname = useAssetHost ? 'eu-assets.i.posthog.com' : 'eu.i.posthog.com'

    const url = new URL(event.request.url)
    url.protocol = 'https:'
    url.hostname = hostname
    url.port = '443'
    url.pathname = pathname.replace(/^\/ingest/, '')

    const headers = new Headers(event.request.headers)
    headers.set('host', hostname)
    headers.set('accept-encoding', '')

    const clientIp = event.request.headers.get('x-forwarded-for') || event.getClientAddress()
    if (clientIp) {
      headers.set('x-forwarded-for', clientIp)
    }

    const response = await fetch(url.toString(), {
      method: event.request.method,
      headers,
      body: event.request.body,
      // @ts-expect-error - duplex is required for streaming request bodies
      duplex: 'half',
    })

    return response
  }

  return resolve(event)
}

/** Server start: check the speech models still have OpenRouter endpoints (logs, never blocks boot). */
export const init: ServerInit = () => {
  void reportSpeechModelsAtStartup()
}

export const handle: Handle = sequence(
  handleCsrf,
  handlePostHogProxy,
  handleParaglide,
  handleWellKnown,
  handleBetterAuth,
  handleCrossOriginOpenerPolicy,
)

export const handleError: HandleServerError = ({ error, status, event }) => {
  if (status !== 404) {
    captureServerException(error, event.locals.user?.id, {
      status,
      path: event.url.pathname,
      route_id: event.route?.id ?? null,
    })
  }
}
