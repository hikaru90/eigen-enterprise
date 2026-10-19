import { usesApiShape } from '$lib/server/llm/api-shapes'

/**
 * The orchestrator's loop engine (plan/phase-durable.md D6, amended 2026-10-19
 * — see plan/progress.md decision log). `builtin-json` is the engine of record;
 * `durable` (pi-durable) needs native tool calls.
 *
 * The choice is explicit and recorded, never a silent switch:
 * - At provider connect time, `engineForProvider` records the engine on the
 *   provider row (llm_provider_config.orchestrator_engine): OpenAI-compatible
 *   providers → durable; the subscription sign-ins on API-shape adapters
 *   (Claude/ChatGPT) cannot carry tool calls → builtin-json.
 * - Each dispatch runs the engine recorded for the conversing user's ACTIVE
 *   provider. `EE_ORCHESTRATOR_ENGINE` is an operator pin over that (rollback
 *   lever); a pinned `durable` on an API-shape provider fails loud in the gateway.
 */
export const ORCHESTRATOR_ENGINES = ['builtin-json', 'durable'] as const
export type OrchestratorEngineId = (typeof ORCHESTRATOR_ENGINES)[number]

export function isOrchestratorEngineId(raw: string): raw is OrchestratorEngineId {
  return (ORCHESTRATOR_ENGINES as readonly string[]).includes(raw)
}

export function orchestratorEnginePinFromEnv(
  env: Record<string, string | undefined>,
): OrchestratorEngineId | null {
  const raw = env.EE_ORCHESTRATOR_ENGINE?.trim()
  if (raw === undefined || raw === '') return null
  if (isOrchestratorEngineId(raw)) return raw
  throw new Error(`EE_ORCHESTRATOR_ENGINE must be one of ${ORCHESTRATOR_ENGINES.join(', ')}, got: "${raw}"`)
}

export type EngineChoice =
  | { engine: 'durable'; reason: 'openai_compatible_tools' }
  | { engine: 'builtin-json'; reason: 'api_shape_no_tools' }

/** Recorded once per provider row at connect time. */
export function engineForProvider(provider: string): EngineChoice {
  return usesApiShape(provider)
    ? { engine: 'builtin-json', reason: 'api_shape_no_tools' }
    : { engine: 'durable', reason: 'openai_compatible_tools' }
}

/**
 * The engine for one dispatch. `recorded` is null when no BYOK provider is
 * active for the conversing human (platform billing, or no human at all, e.g.
 * principal-attributed Telegram turns): the engine of record runs.
 */
export function resolveDispatchEngine(input: {
  pin: OrchestratorEngineId | null
  recorded: OrchestratorEngineId | null
}): OrchestratorEngineId {
  return input.pin ?? input.recorded ?? 'builtin-json'
}
