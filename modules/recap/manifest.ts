import type { ModuleManifest } from '$lib/kernel/modules'
import { RECAP_MODULE_ID, RECAP_TOOL_NAMES } from './types'

export const recapManifest: ModuleManifest = {
  id: RECAP_MODULE_ID,
  name: 'Recap',
  version: '0.1.0',
  description:
    'The company reports to its owner: aggregates the last 24h of kernel events into a deterministic summary and delivers it to allowlisted Telegram owner chats (recap.completed event on every run).',
  tools: [...RECAP_TOOL_NAMES],
  permissions: { roles: ['owner', 'admin'] },
}
