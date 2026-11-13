import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import { buildShellNav, IN_SHELL, NESTED_IN } from '$lib/shell/nav'
import { chatGatewayManifest } from '../../../modules/chat-gateway/manifest'
import { moduleManifests } from '../../../modules/index'
import { recapManifest } from '../../../modules/recap/manifest'
import { allRoutePrefixes, PLUGIN_ROUTES, routeOwner } from './routes'

/**
 * The plugin route map is complete (owner, 2026-11-12: every sidebar entry is
 * a plugin, and a switched-off plugin is off everywhere): every route under
 * (nucleus) and api is classified, every sidebar entry leads to its plugin's
 * pages, every plugin has routes, and the map names no route that is gone.
 */

const ROUTES = fileURLToPath(new URL('../../routes', import.meta.url))
const ROUTE_FILE = /^\+(page|page\.server|server)\.(ts|svelte)$/

/** Route directories (relative to src/routes) that hold a page or an endpoint. */
function routeDirs(dir: string, rel: string[] = []): string[][] {
  const out: string[][] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  if (entries.some((e) => e.isFile() && ROUTE_FILE.test(e.name))) out.push(rel)
  for (const e of entries) if (e.isDirectory()) out.push(...routeDirs(join(dir, e.name), [...rel, e.name]))
  return out
}

/** URL segments of a route dir: groups dropped; a param stays a param (null). */
function urlSegments(dir: string[]): (string | null)[] {
  return dir.filter((s) => !/^\(.+\)$/.test(s)).map((s) => (/^\[.+\]$/.test(s) ? null : s))
}

const isCatchAll = (dir: string[]) => dir.some((s) => s.startsWith('[...'))

const nucleus = routeDirs(join(ROUTES, '(nucleus)'), ['(nucleus)'])
const api = routeDirs(join(ROUTES, 'api'), ['api'])
const routes = [...nucleus, ...api].filter((d) => !isCatchAll(d))
/** A concrete path for a route dir (params filled with a sample value). */
const samplePath = (dir: string[]) => `/${urlSegments(dir).map((s) => s ?? 'sample-id').join('/')}`.replace(/\/$/, '') || '/'

const plugins = [
  ...moduleManifests,
  chatGatewayManifest(async () => ({ allowlistCount: 0, sessionsCount: 0 })).manifest,
  recapManifest,
].filter((m) => m.internal !== true)
const owner = Object.fromEntries(CAPABILITIES.map((c) => [c, true])) as Capabilities

describe('plugin route map', () => {
  it('sees the route tree (sanity: the scan found pages and APIs)', () => {
    expect(nucleus.length).toBeGreaterThan(20)
    expect(api.length).toBeGreaterThan(50)
  })

  it('classifies every route under (nucleus) and api: a plugin owns it or it is core', () => {
    const unclassified = routes.map(samplePath).filter((path) => routeOwner(path) === null)
    expect(unclassified).toEqual([])
  })

  it('names no route that is gone: every prefix leads to at least one real route', () => {
    const patterns = routes.map(urlSegments)
    const leadsSomewhere = (prefix: string) => {
      const want = prefix === '/' ? [] : prefix.slice(1).split('/')
      return patterns.some((p) => want.length <= p.length && want.every((seg, i) => p[i] === null || p[i] === seg))
    }
    expect(allRoutePrefixes().filter((p) => !leadsSomewhere(p))).toEqual([])
  })

  it('has an entry for every plugin (every module with a sidebar entry), and none for a module that is not one', () => {
    expect(Object.keys(PLUGIN_ROUTES).sort()).toEqual(plugins.map((m) => m.id).sort())
  })

  it('every sidebar entry but Settings leads to a page of its own plugin', () => {
    const nav = buildShellNav(plugins, new Map(plugins.map((m) => [m.id, true])), owner)
    const entries = nav.items.filter((i) => i.id !== 'settings')
    const inShell: readonly string[] = IN_SHELL
    expect(entries.map((i) => i.id).sort()).toEqual(
      plugins.map((m) => m.id).filter((id) => !(id in NESTED_IN) && !inShell.includes(id)).sort(),
    )
    for (const item of entries) {
      expect(routeOwner(item.href), item.href).toEqual({ owner: 'plugin', plugin: item.id, surface: 'page' })
    }
  })

  it('a plugin nested in another area (GitHub repos in Drive, Contacts in Email) still owns its page there', () => {
    expect(NESTED_IN).toEqual({ repos: 'drive', contacts: 'email' })
    for (const id of Object.keys(NESTED_IN)) {
      expect(routeOwner(PLUGIN_ROUTES[id].page), id).toEqual({ owner: 'plugin', plugin: id, surface: 'page' })
    }
  })

  it('the Assistant (in the shell, no sidebar entry) owns its conversation pages and APIs; the agent engine, approvals, activity log and speech stay core', () => {
    expect(PLUGIN_ROUTES.assistant).toEqual({ page: '/assistant', api: ['/api/assistant', '/api/chat'] })
    for (const path of ['/assistant', '/assistant/42', '/m/assistant']) {
      expect(routeOwner(path), path).toEqual({ owner: 'plugin', plugin: 'assistant', surface: 'page' })
    }
    for (const path of ['/api/chat', '/api/assistant/conversation', '/api/assistant/activity']) {
      expect(routeOwner(path), path).toEqual({ owner: 'plugin', plugin: 'assistant', surface: 'api' })
    }
    for (const path of [
      '/assistant/activity',
      '/api/agent/runs',
      '/api/agent/runs/7/events',
      '/api/agents',
      '/api/approvals',
      '/api/activity',
      '/api/tts',
      '/api/voice/transcribe',
      '/api/capture/transcribe',
    ]) {
      expect(routeOwner(path), path).toEqual({ owner: 'core' })
    }
  })

  it('keeps Settings (with Settings → Plugins) core: a switched-off plugin can always be switched back on', () => {
    expect(routeOwner('/settings/modules')).toEqual({ owner: 'core' })
    expect(routeOwner('/settings')).toEqual({ owner: 'core' })
  })

  it.each([
    ['/drive', 'drive', 'page'],
    ['/drive/file/abc', 'drive', 'page'],
    ['/api/drive/upload', 'drive', 'api'],
    ['/messages', 'messages', 'page'],
    ['/api/messages/stream', 'messages', 'api'],
    ['/calls/abc', 'calls', 'page'],
    ['/api/calls/abc/token', 'calls', 'api'],
    ['/m/email/domains', 'email', 'page'],
    ['/api/mail/send', 'email', 'api'],
    ['/brand/extract', 'brand', 'page'],
    ['/m/brand', 'brand', 'page'],
    ['/m/memory/tasks', 'memory', 'page'],
    ['/api/capture/submit', 'memory', 'api'],
    ['/api/timeline/projects', 'memory', 'api'],
    ['/m/email/people/new', 'contacts', 'page'],
    ['/m/contacts/new', 'contacts', 'page'],
    ['/drive/github', 'repos', 'page'],
    ['/m/repos', 'repos', 'page'],
    ['/api/contacts/extract', 'contacts', 'api'],
    ['/m/website/apps/new', 'website', 'page'],
    ['/m/recap', 'recap', 'page'],
    ['/m/calendar', 'calendar', 'page'],
  ] as const)('%s belongs to %s (%s)', (path, plugin, surface) => {
    expect(routeOwner(path)).toMatchObject({ owner: 'plugin', plugin, surface })
  })

  it('matches by segment: a longer core prefix beats the plugin (dictation stays on with Memory off)', () => {
    expect(routeOwner('/api/capture/transcribe')).toEqual({ owner: 'core' })
    expect(routeOwner('/api/capture/transcribe-chunk')).toEqual({ owner: 'core' })
    expect(routeOwner('/api/capture/transcribed')).toMatchObject({ plugin: 'memory' })
    expect(routeOwner('/drivers')).toBeNull()
    expect(routeOwner('/m')).toEqual({ owner: 'core' })
    expect(routeOwner('/m/unknown-thing')).toEqual({ owner: 'core' })
  })

  it('leaves routes outside (nucleus) and api alone (sign-in, the public site)', () => {
    expect(routeOwner('/login')).toBeNull()
    expect(routeOwner('/s/home')).toBeNull()
  })

  it('decides every provider webhook explicitly (see the `why` of each)', () => {
    const decided = Object.fromEntries(
      Object.values(PLUGIN_ROUTES).flatMap((r) => Object.entries(r.webhooks ?? {}).map(([path, rule]) => [path, rule.policy])),
    )
    expect(decided).toEqual({
      '/api/calls/livekit': 'open',
      '/api/github/webhook': 'refuse',
      '/api/website/contact': 'refuse',
      '/api/mail/ses-events': 'open',
      '/api/mail/ses-inbound': 'drop',
      '/api/mail/unsubscribe': 'open',
    })
    expect(routeOwner('/api/mail/unsubscribe/tok123')).toMatchObject({ plugin: 'email', webhook: { policy: 'open' } })
  })
})
