/**
 * The app shell's navigation (phase-cohesion rule 1, phase-workspace W-7,
 * polish P-1/P-2): one fixed order — Messages, Calls, Website, Email, Brand,
 * Memory, Drive, Settings. The assistant is not a nav entry: it is the shell's top bar
 * and panel on every page. The dashboard at `/` is the company badge at the
 * top of the sidebar, not an entry either. Module
 * entries come from the module registry (name + activation state); a module
 * that is not registered is not listed, an inactive one is listed dimmed.
 * Registered modules outside the fixed order follow Memory. Pure — shared by
 * the server load and the shell component.
 */

import type { Pathname } from '$app/types'

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

export function moduleHref(id: string): Pathname {
  return `/m/${encodeURIComponent(id)}` as const
}

/** Module entries with their place in the fixed order and their page. */
const MODULE_ENTRIES: Record<string, { href: Pathname; match?: string[] }> = {
  website: { href: '/m/website' },
  email: { href: '/m/email' },
  // Brand = /brand (the second entry /m/brand is gone).
  brand: { href: '/brand' },
  // Tasks, projects, notes and capture are sub-pages of /m/memory.
  memory: { href: '/m/memory' },
  // The team's chat (phase-workspace C1).
  messages: { href: '/messages' },
  // Video calls (plan/video-calls.md §3): recent calls, live calls, new meeting.
  calls: { href: '/calls' },
  // Drive (D1): the company's files at /drive, right after Memory.
  drive: { href: '/drive' },
}

export function buildShellNav(
  manifests: readonly ManifestLike[],
  activations: Map<string, boolean>,
): ShellNav {
  const visible = manifests.filter((m) => m.internal !== true)
  const moduleItem = (m: ManifestLike): ShellNavItem => {
    const entry = MODULE_ENTRIES[m.id]
    return {
      id: m.id,
      name: m.name,
      href: entry?.href ?? moduleHref(m.id),
      active: activations.get(m.id) === true,
      ...(entry?.match ? { match: entry.match } : {}),
    }
  }
  const known = (id: string): ShellNavItem[] => visible.filter((m) => m.id === id).map(moduleItem)
  const others = visible.filter((m) => !(m.id in MODULE_ENTRIES)).map(moduleItem)

  return {
    items: [
      ...known('messages'),
      ...known('calls'),
      ...known('website'),
      ...known('email'),
      ...known('brand'),
      ...known('memory'),
      ...known('drive'),
      ...others,
      { id: 'settings', name: 'Settings', href: '/settings', active: true },
    ],
  }
}

/** What the signed-in layout hands the shell. */
export type ShellData = {
  /** From the founding journey; null until the company has been named. */
  companyName: string | null
  nav: ShellNav
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
