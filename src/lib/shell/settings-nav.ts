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
  // The company's domains: bought through eigenEnterprise or connected (plan/managed-domains.md) — owner and admins.
  { id: 'domains', name: 'Domains', href: '/settings/domains' },
  { id: 'members', name: 'Members & invites', href: '/settings/members' },
  // Who reports to whom, people and AI co-workers (plan/phase-ai-coworkers.md C5) — every member;
  // a seat's profile is below it (/settings/org/[id]).
  { id: 'org', name: 'Org chart', href: '/settings/org' },
  // AI co-workers: create from a template, model, lens, caps, on/off — owner and admins.
  { id: 'coworkers', name: 'Co-workers', href: '/settings/coworkers' },
  { id: 'llm', name: 'AI provider', href: '/settings/llm' },
  // Where the company's AI money goes: by product, person and co-worker, model — owner and admins.
  { id: 'ai-usage', name: 'AI usage', href: '/settings/ai-usage' },
  { id: 'passkeys', name: 'Passkeys & sessions', href: '/settings/passkeys' },
  { id: 'api-keys', name: 'API keys', href: '/settings/api-keys' },
  { id: 'approvals', name: 'Approval mode', href: '/settings/approvals' },
  // Every plugin, on or off, and the switch (owner, 2026-11-12) — owner and admins.
  { id: 'modules', name: 'Plugins', href: '/settings/modules' },
  // Updating eigenEnterprise on this server (ee does it) — owner and admins.
  { id: 'updates', name: 'Updates', href: '/settings/updates' },
  // The owner's alone: backups hold the company's recovery code (D11).
  { id: 'backups', name: 'Backups', href: '/settings/backups' },
  // The owner's alone: everything the company owns, in open formats (plan/phase-export.md).
  { id: 'export', name: 'Export', href: '/settings/export' },
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
