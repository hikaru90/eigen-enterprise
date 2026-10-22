/**
 * Per-module settings slots: where a module's settings live. A module fills
 * its slot here with links to the settings surfaces that already exist; the
 * module page renders whatever the slot holds. A module with no slot simply
 * has no settings yet (shown as such, never invented).
 */

import type { Pathname } from '$app/types'

export type ModuleSettingsLink = { label: string; href: Pathname; text: string }
/** A built-in panel the module page renders under the links (e.g. Email's mail-sending keys). */
export type ModuleSettingsPanel = 'mail-keys' | 'website-activity'
export type ModuleSettingsSlot = {
  links: ModuleSettingsLink[]
  note?: string
  panel?: ModuleSettingsPanel
}

const slots: Record<string, ModuleSettingsSlot> = {
  email: {
    note: 'The sender (Amazon SES) is set up in the welcome flow. There is no separate settings page yet.',
    links: [
      { label: 'Ask in the chat', href: '/', text: 'Change the sender or check its status.' },
    ],
    panel: 'mail-keys',
  },
  brand: {
    links: [{ label: 'Brand studio', href: '/brand', text: 'Pick and edit the visual set.' }],
  },
  memory: {
    links: [{ label: 'Memory', href: '/memory', text: 'Notes, tasks and the timeline.' }],
  },
  website: {
    links: [
      {
        label: 'Repositories & apps',
        href: '/m/website',
        text: 'All connected repositories and their deployments.',
      },
      {
        label: 'Website settings',
        href: '/m/website/settings',
        text: 'Domains, routing, automatic HTTPS and deployment server status.',
      },
    ],
    panel: 'website-activity',
  },
}

export function moduleSettingsSlot(moduleId: string): ModuleSettingsSlot | null {
  return slots[moduleId] ?? null
}
