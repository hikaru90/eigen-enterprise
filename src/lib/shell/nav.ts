/**
 * The app shell's navigation: fixed app entries plus one entry per module,
 * built from the module registry and its activation state (never a hardcoded
 * module list). Pure — shared by the server load and the shell component.
 */

import type { Pathname } from '$app/types'

export type ShellNavItem = { id: string; name: string; href: Pathname; active: boolean }

export type ShellNav = {
  primary: ShellNavItem[]
  modules: ShellNavItem[]
  available: ShellNavItem[]
  secondary: ShellNavItem[]
}

/** `internal` modules are the agent's own machinery: never in the owner's nav. */
type ManifestLike = { id: string; name: string; internal?: boolean }

export function moduleHref(id: string): Pathname {
  return `/m/${encodeURIComponent(id)}` as const
}

export function buildShellNav(
  manifests: readonly ManifestLike[],
  activations: Map<string, boolean>,
): ShellNav {
  const items = manifests
    .filter((m) => m.internal !== true)
    .map((m) => ({
      id: m.id,
      name: m.name,
      href: moduleHref(m.id),
      active: activations.get(m.id) === true,
    }))
  return {
    primary: [
      { id: 'chat', name: 'Chat', href: '/', active: true },
      { id: 'overview', name: 'Overview', href: '/overview', active: true },
    ],
    modules: items.filter((i) => i.active),
    available: items.filter((i) => !i.active),
    secondary: [{ id: 'settings', name: 'Settings', href: '/settings', active: true }],
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

/** Active route match: exact for "/", segment prefix for everything else. */
export function navItemCurrent(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}
