import type { ModuleManifest } from '$lib/kernel/modules'

export const CALLS_MODULE_ID = 'calls'

export const CALLS_TOOL_NAMES = ['calls.list', 'calls.start', 'calls.end'] as const

/**
 * Calls: video calls for direct messages, channels and meetings
 * (plan/video-calls.md). A system module (self-seeded active); every call,
 * 1:1 and group, goes through the company's LiveKit server. People join the
 * media; the agent only lists, starts (rings — approval-gated) and ends calls,
 * and never gets a media token.
 */
export const callsManifest: ModuleManifest = {
  id: CALLS_MODULE_ID,
  name: 'Calls',
  version: '0.1.0',
  description: 'Video calls for direct messages, channels and meetings, on the company’s own LiveKit server.',
  // DM and channel calls ring the people of a Messages conversation (callContextsFromMessages).
  requires: ['messages'],
  tools: [...CALLS_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
