/**
 * The orchestrator's loop engine (plan/phase-durable.md D6): `builtin-json` is
 * the engine of record; `durable` opts in. Durable needs native tool calls, which
 * the subscription sign-ins (Claude/ChatGPT API-shape adapters) cannot carry yet —
 * so it is an explicit choice per company, never a silent switch.
 */
export const ORCHESTRATOR_ENGINES = ['builtin-json', 'durable'] as const
export type OrchestratorEngineId = (typeof ORCHESTRATOR_ENGINES)[number]

export function orchestratorEngineFromEnv(env: Record<string, string | undefined>): OrchestratorEngineId {
  const raw = env.EE_ORCHESTRATOR_ENGINE?.trim()
  if (raw === undefined || raw === '') return 'builtin-json'
  if ((ORCHESTRATOR_ENGINES as readonly string[]).includes(raw)) return raw as OrchestratorEngineId
  throw new Error(`EE_ORCHESTRATOR_ENGINE must be one of ${ORCHESTRATOR_ENGINES.join(', ')}, got: "${raw}"`)
}
