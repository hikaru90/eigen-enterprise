/**
 * The one settings sub-navigation (phase-cohesion rule 3): only what belongs
 * to the whole company. Module settings live on their module's page. Which
 * sections someone sees comes from their capability set (the same rules the
 * section pages guard with), so no tab leads to a 403.
 */

import type { Pathname } from '$app/types'
import { canOpen, type Capabilities } from '$lib/access/capabilities'

export type SettingsSection = {
  id: string
  name: string
  href: Pathname
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'account', name: 'Account', href: '/settings' },
  // The company's name and logo (top left of the app) — owner and admins.
  { id: 'company', name: 'Company', href: '/settings/company' },
  { id: 'members', name: 'Members & invites', href: '/settings/members' },
  { id: 'llm', name: 'AI provider', href: '/settings/llm' },
  { id: 'passkeys', name: 'Passkeys & sessions', href: '/settings/passkeys' },
  { id: 'api-keys', name: 'API keys', href: '/settings/api-keys' },
  { id: 'approvals', name: 'Approval mode', href: '/settings/approvals' },
  // The owner's alone: backups hold the company's recovery code (D11).
  { id: 'backups', name: 'Backups', href: '/settings/backups' },
]

export function settingsSections(capabilities: Capabilities): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => canOpen(capabilities, s.href))
}

/** The current section: exact for the Account root, prefix for the rest. */
export function currentSettingsSection(pathname: string): string | null {
  if (pathname === '/settings') return 'account'
  const hit = SETTINGS_SECTIONS.find(
    (s) => s.href !== '/settings' && (pathname === s.href || pathname.startsWith(`${s.href}/`)),
  )
  return hit?.id ?? null
}
