import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the substrate module (single source of truth for the manifest). */
export const SUBSTRATE_TOOL_NAMES = [
  'substrate.status',
  'substrate.domain_add',
  'substrate.domain_remove',
  'substrate.app_remove',
  'substrate.secret_set',
] as const

/**
 * The company's hands on its own box (plan/phase-substrate.md): domains, apps
 * and secrets, through ee's control socket. A system module — part of the OS,
 * self-seeded active like the kernel module — and mutations are human-only
 * (D11: no agent may change the box on the strength of text it read).
 */
export const substrateManifest: ModuleManifest = {
  id: 'substrate',
  name: 'Hosting',
  version: '0.1.0',
  description:
    'Domains, apps and secrets on this server, through ee (the company init). Reads for the agent; changes by a human only.',
  tools: [...SUBSTRATE_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}

export const SUBSTRATE_MODULE_ID = substrateManifest.id
