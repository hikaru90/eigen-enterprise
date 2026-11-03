/**
 * The one settings sub-navigation (phase-cohesion rule 3): only what belongs
 * to the whole company. Module settings live on their module's page.
 */

import type { Pathname } from '$app/types'

export type SettingsSection = {
  id: string
  name: string
  href: Pathname
  adminOnly: boolean
  /** Only the owner sees it (backups hold the company's recovery code; D11). */
  ownerOnly?: boolean
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'account', name: 'Account', href: '/settings', adminOnly: false },
  { id: 'members', name: 'Members & invites', href: '/settings/members', adminOnly: true },
  { id: 'llm', name: 'AI provider', href: '/settings/llm', adminOnly: false },
  { id: 'passkeys', name: 'Passkeys & sessions', href: '/settings/passkeys', adminOnly: false },
  { id: 'api-keys', name: 'API keys', href: '/settings/api-keys', adminOnly: false },
  { id: 'approvals', name: 'Approval mode', href: '/settings/approvals', adminOnly: true },
  { id: 'backups', name: 'Backups', href: '/settings/backups', adminOnly: true, ownerOnly: true },
]

export function settingsSections(isAdmin: boolean, isOwner = false): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => (s.ownerOnly ? isOwner : isAdmin || !s.adminOnly))
}

/** The current section: exact for the Account root, prefix for the rest. */
export function currentSettingsSection(pathname: string): string | null {
  if (pathname === '/settings') return 'account'
  const hit = SETTINGS_SECTIONS.find(
    (s) => s.href !== '/settings' && (pathname === s.href || pathname.startsWith(`${s.href}/`)),
  )
  return hit?.id ?? null
}
