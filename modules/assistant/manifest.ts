import type { ModuleManifest } from '$lib/kernel/modules'

export const ASSISTANT_MODULE_ID = 'assistant'

/**
 * The Assistant (owner, 2026-11-12: every sidebar entry is a plugin, the
 * Assistant/Chat among them): the members' conversation with the company
 * agent — the shell's top bar ("Ask the assistant…", ⌘K) and panel, the
 * conversation pages (/assistant, /assistant/[id]) and their APIs
 * (/api/chat, /api/assistant/**). An official plugin: seeded on once,
 * Settings → Plugins switches it off; switched off, the shell has no top bar
 * field and no panel and its pages and APIs are off (the plugin gate).
 *
 * Not in it — the core, which other plugins use (decision log, round 5):
 * the durable agent engine and its runs (/api/agent/**), the kernel registry,
 * approvals (/api/approvals), the company activity log (/assistant/activity)
 * and speech (/api/tts, dictation). It brings no agent tools: the agent's
 * hands are the other plugins' tools and the internal orchestrator module.
 */
export const assistantManifest: ModuleManifest = {
  id: ASSISTANT_MODULE_ID,
  name: 'Assistant',
  version: '0.1.0',
  description:
    'Talk to the company agent from every page: the top bar, the side panel and the conversations.',
  tools: [],
  permissions: { roles: ['admin', 'agent'] },
}
