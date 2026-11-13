import type { Pathname } from '$app/types'

/**
 * Which plugin owns which route (owner, 2026-11-12: every sidebar entry is a
 * plugin; a switched-off one is switched off everywhere — its pages, its
 * APIs, its background work). The one map the plugin gate
 * ($lib/server/plugins/gate) reads and the sidebar takes its hrefs from, so
 * the dimmed entry and the gate cannot disagree. Pure (shared by server and
 * shell).
 *
 * Every route under src/routes/(nucleus) and src/routes/api is classified
 * here — owned by a plugin, or listed in CORE_ROUTES — and routes.spec.ts
 * fails for a route nobody classified, so a new plugin (or a new route of an
 * old one) cannot forget it. Matching is by path segment; the longest prefix
 * wins, so a core exception inside a plugin's prefix (dictation under
 * /api/capture) beats the plugin.
 */

/**
 * What a provider's webhook gets while its plugin is switched off:
 * - `drop`: accepted (200) and dropped with one log line — the provider must
 *   not retry, nothing is processed;
 * - `refuse`: the plugin_inactive JSON error (409) — the caller shows or keeps
 *   the failure (GitHub keeps a failed delivery to redeliver);
 * - `open`: keeps working while switched off (bookkeeping that keeps stored
 *   state true; never starts anything) — the route's own checks run unchanged.
 */
export type WebhookPolicy = 'drop' | 'refuse' | 'open'

export type WebhookRule = {
  /** Who calls it. */
  caller: string
  policy: WebhookPolicy
  /** Why this policy (shown in the spec, read by the next person). */
  why: string
}

export type PluginRoutes = {
  /** The sidebar entry's page (its href). */
  page: Pathname
  /** Further page prefixes of the plugin (besides `page` and `/m/<id>`). */
  pages?: string[]
  /** API prefixes the plugin owns. */
  api: string[]
  /** Provider webhooks inside the plugin's API prefixes and what they get while it is off. */
  webhooks?: Record<string, WebhookRule>
}

/** The generic module page of a plugin without a page of its own. */
export function moduleHref(id: string): Pathname {
  return `/m/${encodeURIComponent(id)}` as const
}

export const PLUGIN_ROUTES: Record<string, PluginRoutes> = {
  messages: { page: '/messages', api: ['/api/messages'] },
  calls: {
    page: '/calls',
    api: ['/api/calls'],
    webhooks: {
      '/api/calls/livekit': {
        caller: 'LiveKit (the company’s livekit-server)',
        policy: 'open',
        why: 'Room and participant ends close calls that already exist (signature-checked as always); dropping them would leave calls “live” forever. It starts nothing: with Calls off no call can start or be joined.',
      },
    },
  },
  website: {
    page: '/m/website',
    api: ['/api/website', '/api/github'],
    webhooks: {
      '/api/github/webhook': {
        caller: 'GitHub (the connected GitHub App)',
        policy: 'refuse',
        why: 'A push must not deploy while Website is off; GitHub keeps the failed delivery, so it can be redelivered once Website is on.',
      },
      '/api/website/contact': {
        caller: 'Visitors of the company website (contact form)',
        policy: 'refuse',
        why: 'Nothing is stored while Website is off; the visitor’s form gets a clear error instead of a silent loss.',
      },
    },
  },
  email: {
    page: '/m/email',
    api: ['/api/mail'],
    webhooks: {
      '/api/mail/ses-events': {
        caller: 'Amazon SNS (SES delivery events)',
        policy: 'open',
        why: 'Bounces and complaints of mail sent before the switch-off keep the suppression list true (SNS-signature-checked as always); it sends nothing.',
      },
      '/api/mail/ses-inbound': {
        caller: 'Amazon SNS (SES receipt notifications)',
        policy: 'drop',
        why: 'No mail is taken in while Email is off; a refusal would only make SNS retry and give up. The raw mail stays in the company’s inbound S3 bucket.',
      },
      '/api/mail/unsubscribe': {
        caller: 'Recipients (the unsubscribe link in a sent mail)',
        policy: 'open',
        why: 'An unsubscribe must always work, also for mail sent before the switch-off.',
      },
    },
  },
  brand: { page: '/brand', api: ['/api/brand'] },
  memory: {
    page: '/m/memory',
    api: [
      '/api/capture',
      '/api/thoughts',
      '/api/text-files',
      '/api/entities',
      '/api/graph',
      '/api/embeddings',
      '/api/timeline',
      '/api/temporal-events',
      '/api/memories',
      '/api/memory',
      '/api/retrieval',
    ],
  },
  drive: { page: '/drive', api: ['/api/drive'] },
  // Pages only: the calendar's reads and writes are the page's load and form actions.
  calendar: { page: '/m/calendar', api: [] },
  // Inside the Email area (Email → Contacts); /m/contacts/** redirects there.
  contacts: { page: '/m/email/people', api: ['/api/contacts'] },
  // Inside the Drive area (Drive → GitHub); /m/repos redirects there.
  repos: { page: '/drive/github', api: [] },
  // Booted only when switched on (no page or API of their own beyond /m/<id>).
  'chat-gateway': { page: moduleHref('chat-gateway'), api: [] },
  recap: { page: moduleHref('recap'), api: [] },
}

/**
 * Routes no plugin owns: the core (kernel, agent, members, settings,
 * onboarding, auth). Settings → Plugins is here, so a switched-off plugin can
 * always be switched back on. `/` matches only itself.
 */
export const CORE_ROUTES: readonly string[] = [
  // Pages (src/routes/(nucleus))
  '/',
  '/assistant',
  '/contribute',
  '/settings',
  // The generic module page; each plugin's /m/<id> belongs to that plugin.
  '/m',
  // APIs (src/routes/api)
  '/api/activity',
  '/api/admin',
  '/api/agent',
  '/api/agents',
  '/api/approvals',
  '/api/assistant',
  // Dictation in the assistant (and every mic) uses the capture transcription endpoints.
  '/api/capture/transcribe',
  '/api/capture/transcribe-chunk',
  '/api/chat',
  '/api/claim',
  '/api/company',
  '/api/contribute',
  '/api/e2e',
  '/api/grounding',
  '/api/health',
  // The central Contribute board's machine endpoints (modules/contribute-hub): other installs call
  // them without a session, signed per request; they answer 404 themselves while the hub module is off.
  '/api/hub',
  '/api/keys',
  '/api/log',
  '/api/mcp',
  '/api/onboarding',
  '/api/people',
  '/api/profile',
  '/api/push',
  '/api/scheduled-tasks',
  '/api/session',
  '/api/settings',
  '/api/tts',
  '/api/voice',
  '/api/webhooks',
]

/** What the switched-off page of a plugin shows (the plugin gate hands it to the error page). */
export type PluginOff = {
  id: string
  name: string
  /** Owner or admin: may switch it on (Settings → Plugins). */
  canManage: boolean
}

/** The switched-off page's heading (and its App.Error message). */
export function pluginOffMessage(name: string): string {
  return `${name} is switched off`
}

export type RouteOwner =
  | { owner: 'core' }
  | { owner: 'plugin'; plugin: string; surface: 'page' | 'api'; webhook?: WebhookRule }

/** Segment prefix match: `/drive` matches `/drive` and `/drive/x`, never `/drivers`. */
function under(prefix: string, pathname: string): boolean {
  if (prefix === '/') return pathname === '/'
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

type Rule = { prefix: string; owner: RouteOwner }

function rules(): Rule[] {
  const out: Rule[] = CORE_ROUTES.map((prefix) => ({ prefix, owner: { owner: 'core' } }))
  for (const [plugin, routes] of Object.entries(PLUGIN_ROUTES)) {
    const pages = new Set([routes.page, moduleHref(plugin), ...(routes.pages ?? [])])
    for (const prefix of pages) out.push({ prefix, owner: { owner: 'plugin', plugin, surface: 'page' } })
    for (const prefix of routes.api) out.push({ prefix, owner: { owner: 'plugin', plugin, surface: 'api' } })
    for (const [prefix, webhook] of Object.entries(routes.webhooks ?? {})) {
      out.push({ prefix, owner: { owner: 'plugin', plugin, surface: 'api', webhook } })
    }
  }
  // Longest prefix first: the most specific rule wins.
  return out.sort((a, b) => b.prefix.length - a.prefix.length)
}

const RULES = rules()

/** Who owns a path: a plugin (page or API, maybe a webhook), the core, or nobody here (null: e.g. /login). */
export function routeOwner(pathname: string): RouteOwner | null {
  for (const rule of RULES) if (under(rule.prefix, pathname)) return rule.owner
  return null
}

/** Every prefix the map names (the spec checks each one matches a real route). */
export function allRoutePrefixes(): string[] {
  return RULES.map((r) => r.prefix)
}
