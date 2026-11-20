import { describe, expect, it, vi } from 'vitest'

// Hermetic: building the kernel must not depend on the developer machine's .env.
vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))
// The chat handler module imports the DB layer at load; nothing here touches it.
vi.mock('$lib/server/db', () => ({}))

import { InMemoryApprovalModeStore, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { buildKernel } from '../../../../modules/index'
import { BRIEFING_BOOTSTRAP_MESSAGES, BRIEFING_TOOLS } from './handle-agent-chat-post'

/**
 * The briefing turns tell the brain which tools to use. Before CB3 they named
 * `list_projects` / `answer_question` — names the registry does not have, so
 * the brain could not follow them. Every tool they name must be a registry
 * tool that every MEMBER reaches through the brain (a briefing is about the
 * person's own Memory, tasks and calendar).
 */
describe('briefing turns name tools that exist, for every member', () => {
  const kernel = buildKernel({
    activations: new InMemoryActivationStore(),
    eventSink: new InMemoryEventSink(),
    approvalStore: new InMemoryApprovalStore(),
    approvalMode: new InMemoryApprovalModeStore('ask'),
    vcsCommitter: null,
  })

  it('every briefing tool is a registry tool a member may use', () => {
    for (const name of BRIEFING_TOOLS) {
      const tool = kernel.registry.get(name)
      expect(tool, name).toBeDefined()
      expect(tool!.permission.roles, name).toContain('member')
    }
  })

  it('each briefing names only those tools (no answer_question, no bare names)', () => {
    for (const [period, message] of Object.entries(BRIEFING_BOOTSTRAP_MESSAGES)) {
      expect(message, period).not.toMatch(/answer_question/)
      const named = message.match(/\b[a-z_]+\.[a-z_]+\b/g) ?? []
      expect(named.length, period).toBeGreaterThan(0)
      for (const name of named) expect(BRIEFING_TOOLS as readonly string[], `${period}: ${name}`).toContain(name)
      expect(message, period).not.toMatch(/(?<![.\w])(list_projects|get_project_timeline|retrieve_thoughts)\b/)
    }
  })
})
