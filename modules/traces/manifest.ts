import type { ModuleManifest } from '$lib/kernel/modules'

export const TRACES_MODULE_ID = 'traces'

/** The company's view of what its box sends the makers, and its switch (plan/traces-phone-home.md §4). */
export const TRACES_TOOL_NAMES = ['traces.sent_list', 'traces.sent_get', 'traces.settings_get', 'traces.settings_set', 'traces.withdraw', 'traces.notice_get', 'traces.notice_seen'] as const
/** Owner-only acts: the switch, withdrawing what was sent, and marking the one-time notice seen. */
export const TRACES_OWNER_TOOLS = ['traces.settings_set', 'traces.withdraw', 'traces.notice_seen'] as const

/**
 * Traces (plan/traces-phone-home.md): every box tells the makers how the product behaved —
 * which tool, which model, how long, what failed, on which version — never what the company did.
 * Tier A only (owner, 2026-11-25): closed sets and numbers, open values gated by Jev on the box,
 * on by default with the owner's switch in Settings → Company. A system module (self-seeded
 * active); internal: it lives in Settings → Company, never a sidebar entry.
 */
export const tracesManifest: ModuleManifest = {
  id: TRACES_MODULE_ID,
  name: 'Product signals',
  internal: true,
  version: '0.1.0',
  description: 'Usage statistics (no content) this box shares with the eigenEnterprise makers, and what was sent.',
  tools: [...TRACES_TOOL_NAMES],
  permissions: { roles: ['owner', 'admin', 'agent'] },
}
