import type { Pathname } from '$app/types'
import { canOpen, type Capabilities } from '$lib/access/capabilities'
import { moduleHref, PLUGIN_ROUTES } from '$lib/plugins/routes'
/**
 * The app shell's navigation (phase-cohesion rule 1, phase-workspace W-7,
 * polish P-1/P-2): one fixed order — Messages, Calls, Calendar, Website, Email, Brand,
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
const FIXED_ORDER = ['messages', 'calls', 'calendar', 'website', 'email', 'brand', 'memory', 'drive'] as const

/**
 * Plugins whose pages live inside another entry's area (owner, 2026-11-13):
 * no entry of their own; the parent's entry is current on their pages (and
 * on their old addresses, which redirect). GitHub repos is Drive → GitHub,
 * Contacts is Email → Contacts.
 */
export const NESTED_IN: Readonly<Record<string, string>> = { repos: 'drive', contacts: 'email' }

/**
 * Plugins that are part of the shell itself, not a sidebar entry: the
 * Assistant is the top bar and panel on every page (switched off, the shell
 * has neither — ShellData.assistant). Its pages are its own (the plugin
 * route map); Settings → Plugins switches it.
 */
export const IN_SHELL = ['assistant'] as const

/** The pages of the plugins nested in `parent` — its match prefixes. */
function nestedMatch(parent: string): string[] {
  return Object.entries(NESTED_IN)
    .filter(([, p]) => p === parent)
    .flatMap(([child]) => [PLUGIN_ROUTES[child]?.page ?? moduleHref(child), moduleHref(child)])
}

export function buildShellNav(
  manifests: readonly ManifestLike[],
  activations: Map<string, boolean>,
  capabilities: Capabilities,
): ShellNav {
  const inShell: readonly string[] = IN_SHELL
  const visible = manifests.filter(
    (m) => m.internal !== true && !(m.id in NESTED_IN) && !inShell.includes(m.id),
  )
  const moduleItem = (m: ManifestLike): ShellNavItem => {
    const match = nestedMatch(m.id)
    return {
      id: m.id,
      name: m.name,
      href: PLUGIN_ROUTES[m.id]?.page ?? moduleHref(m.id),
      active: activations.get(m.id) === true,
      ...(match.length > 0 ? { match } : {}),
    }
  }
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
  /**
   * The Assistant plugin is on: the shell shows its top bar field and panel
   * and pages may use it. false = no assistant anywhere in the shell (off
   * means off; a switch takes effect on the next load).
   */
  assistant: boolean
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
