import type { ModuleManifest } from '$lib/kernel/modules'

export const CALLS_MODULE_ID = 'calls'

/** The writes that wait on the company's approval mode (APPROVAL_REQUIRED_TOOLS): ringing, inviting, removing, the Brain. */
export const CALLS_WRITE_TOOLS = [
  'calls.start',
  'calls.schedule',
  'calls.invite_guests',
  'calls.remove_guest',
  'calls.brain_set',
  'calls.brain_share_answer',
] as const

export const CALLS_TOOL_NAMES = [
  'calls.list',
  'calls.start',
  'calls.end',
  'calls.schedule',
  'calls.invite_guests',
  'calls.remove_guest',
  'calls.brain_set',
  'calls.brain_share_answer',
  'calls.brain_recap',
  'calls.chat_post',
  'calls.chat_read',
] as const

/**
 * Calls: video calls for direct messages, channels and meetings
 * (plan/video-calls.md). A system module (self-seeded active); every call,
 * 1:1 and group, goes through the company's LiveKit server. People join the
 * media; the agent lists, starts (rings — approval-gated), books meetings with
 * guests, and as a person their Brain switch, shares and recap, and the
 * call's chat (write, read) — and never gets a media token.
 */
export const callsManifest: ModuleManifest = {
  id: CALLS_MODULE_ID,
  name: 'Calls',
  version: '0.1.0',
  description:
    'Video calls for direct messages, channels and meetings, on the company’s own LiveKit server.',
  // DM and channel calls ring the people of a Messages conversation (callContextsFromMessages).
  requires: ['messages'],
  tools: [...CALLS_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
