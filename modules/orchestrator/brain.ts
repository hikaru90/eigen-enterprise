import type { Brain, TelegramSessionRef } from '../chat-gateway/telegram'
import type { AgentConfig } from '$lib/kernel/agent'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import { BuiltinJsonLoop, type LlmCompleteFn } from '$lib/kernel/engines/builtin-json'

/**
 * The orchestrator is no longer a brain with kernel privileges — it is one
 * hosted agent config (plan/phase-1b-harness.md demotion #1). This file keeps
 * only orchestrator-identity data (principal, persona prompt, LLM identity)
 * and a thin Brain adapter that delegates to the AgentRuntime.
 */

/**
 * The orchestrator principal: the company agent that executes kernel tools on
 * behalf of gateway users. Every tool call runs under this principal —
 * permissions, approval gate, and audit all see it.
 */
export const ORCHESTRATOR_PRINCIPAL: {
  id: string
  kind: 'agent'
  roles: string[]
} = { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }

export const ORCHESTRATOR_AGENT_ID = ORCHESTRATOR_PRINCIPAL.id

/**
 * Gateway billing/config identity for the orchestrator's LLM calls. The
 * llm-client resolves platform credentials for it (LLM_BASE_URL /
 * SERVICE_API_KEY_* env or the platform DB config).
 */
export const ORCHESTRATOR_LLM_USER_ID = 'orchestrator'

/** Persona preamble handed to the builtin-json engine as its system prompt. */
export const ORCHESTRATOR_PERSONA_PROMPT = [
  'You are the orchestrator: the general assistant of this company.',
  'You can act through kernel tools. Every tool call is permission-checked, audited, and (for external actions) gated behind owner approval.',
].join('\n')

/** The orchestrator as harness config: zero code privilege, full harness inherited. */
export function orchestratorAgentConfig(options: { spendCapUsd?: number } = {}): AgentConfig {
  return {
    id: ORCHESTRATOR_AGENT_ID,
    personaName: 'Orchestrator',
    description:
      'The company general assistant: executes kernel tools on behalf of gateway users.',
    loopEngine: 'builtin-json',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    ...(options.spendCapUsd === undefined ? {} : { spendCapUsd: options.spendCapUsd }),
    enabled: true,
  }
}

/** The orchestrator's loop: the extracted builtin-json engine with its persona. */
export function buildOrchestratorEngine(options: {
  complete?: LlmCompleteFn
  llmUserId?: string
} = {}): BuiltinJsonLoop {
  return new BuiltinJsonLoop({
    ...(options.complete === undefined ? {} : { complete: options.complete }),
    systemPrompt: ORCHESTRATOR_PERSONA_PROMPT,
    llmUserId: options.llmUserId ?? ORCHESTRATOR_LLM_USER_ID,
    logContext: 'orchestrator_brain',
  })
}

/**
 * Thin Brain adapter over the harness: gateway sessions dispatch through the
 * AgentRuntime as agent 'orchestrator'. Tool-surface filtering, permissions,
 * approvals, audit, events, and budget live in the runtime — not here.
 */
export class OrchestratorBrain implements Brain {
  private readonly runtime: AgentRuntime

  constructor(options: { runtime: AgentRuntime }) {
    this.runtime = options.runtime
  }

  async respond(session: TelegramSessionRef, text: string): Promise<string> {
    return this.runtime.dispatch(ORCHESTRATOR_AGENT_ID, session.sessionId, text)
  }

  /**
   * The fail-closed tool surface the agent is offered right now (activation ∩
   * scope ∩ role filtered by the runtime) — parity with the pre-harness brain.
   */
  async offeredTools(): Promise<Array<{ name: string }>> {
    return this.runtime.listAgentTools(ORCHESTRATOR_AGENT_ID)
  }
}
