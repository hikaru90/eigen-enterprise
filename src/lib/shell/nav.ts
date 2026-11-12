import type { Pathname } from '$app/types'
import { canOpen, type Capabilities } from '$lib/access/capabilities'
import { moduleHref, PLUGIN_ROUTES } from '$lib/plugins/routes'
/**
 * The app shell's navigation (phase-cohesion rule 1, phase-workspace W-7,
 * polish P-1/P-2): one fixed order — Messages, Calls, Website, Email, Brand,
 * Memory, Drive, Settings. The assistant is not a nav entry: it is the shell's top bar
 * and panel on every page. The dashboard at `/` is the company badge at the
 * top of the sidebar, not an entry either. Module
 * entries come from the module registry (name + activation state); a module
 * that is not registered is not listed, an inactive one is listed dimmed.
 * Registered modules outside the fixed order follow Memory. An entry whose
 * page the signed-in person may not open (their capability set, e.g. the
 * Website pages for a member) is not listed — the nav never leads to a 403.
 * Pure — shared by the server load and the shell component.
 */
import type { SpeechReadiness } from '$lib/voice/dictation-readiness'

export type ShellNavItem = {
  id: string
  name: string
  href: Pathname
  /** false = an inactive module: listed, but dimmed. */
  active: boolean
  /** Path prefixes that belong to this entry besides its href. */
  match?: string[]
}

export type ShellNav = {
  items: ShellNavItem[]
}

/** `internal` modules are the agent's own machinery: never in the owner's nav. */
type ManifestLike = { id: string; name: string; internal?: boolean }

export { moduleHref }

/**
 * The fixed order of the known entries. Each entry's page is its plugin's
 * page in the plugin route map ($lib/plugins/routes) — the same map the
 * plugin gate reads, so a dimmed entry leads to its switched-off page.
 */
const FIXED_ORDER = ['messages', 'calls', 'website', 'email', 'brand', 'memory', 'drive'] as const

export function buildShellNav(
  manifests: readonly ManifestLike[],
  activations: Map<string, boolean>,
  capabilities: Capabilities,
): ShellNav {
  const visible = manifests.filter((m) => m.internal !== true)
  const moduleItem = (m: ManifestLike): ShellNavItem => ({
    id: m.id,
    name: m.name,
    href: PLUGIN_ROUTES[m.id]?.page ?? moduleHref(m.id),
    active: activations.get(m.id) === true,
  })
  const known = (id: string): ShellNavItem[] => visible.filter((m) => m.id === id).map(moduleItem)
  const fixed: readonly string[] = FIXED_ORDER
  const others = visible.filter((m) => !fixed.includes(m.id)).map(moduleItem)

  const items: ShellNavItem[] = [
    ...FIXED_ORDER.flatMap(known),
    ...others,
    { id: 'settings', name: 'Settings', href: '/settings', active: true },
  ]
  return { items: items.filter((item) => canOpen(capabilities, item.href)) }
}

/** What the signed-in layout hands the shell. */
export type ShellData = {
  /** Settings → Company, else the founding journey; null until the company has been named. */
  companyName: string | null
  /** The company logo's route (Settings → Company); null = the initial badge. */
  companyLogo: string | null
  /** What this person may open and do — every menu and card decides from this alone. */
  capabilities: Capabilities
  nav: ShellNav
  /** Whether dictation (speech to text, always on OpenRouter) can work, and what is missing. */
  dictation: SpeechReadiness
}

/**
 * Whether a page renders inside the shell. The welcome tour and the first-run
 * provider gate are full-screen flows of their own; signed-out pages carry no
 * shell data at all.
 */
export function shellVisible(data: {
  shell?: ShellData | null
  showWelcome?: boolean
  needsOnboarding?: boolean
}): boolean {
  if (!data.shell) return false
  return data.showWelcome !== true && data.needsOnboarding !== true
}

/** Route match: exact for "/", segment prefix for everything else. */
export function navItemCurrent(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * The one entry that is current for a path: the longest matching href or
 * match prefix wins (so a module's match prefix beats a shorter href).
 */
export function currentNavId(items: readonly ShellNavItem[], pathname: string): string | null {
  let best: { id: string; len: number } | null = null
  for (const item of items) {
    for (const prefix of [item.href, ...(item.match ?? [])]) {
      if (navItemCurrent(prefix, pathname) && (!best || prefix.length > best.len)) {
        best = { id: item.id, len: prefix.length }
      }
    }
  }
  return best?.id ?? null
}
