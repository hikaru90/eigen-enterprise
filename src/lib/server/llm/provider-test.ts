import { activityProviderForLlmConfig } from '$lib/server/activity/gateway-providers'
import { logActivityCall } from '$lib/server/activity/log-call'
import { getDb } from '$lib/server/db'
import { fetchProviderChatCompletion, usesApiShape } from '$lib/server/llm/api-shapes'
import {
  gatewayHostFromBaseUrl,
  gatewayReportedCostUsdForLog,
  resolveRoutingRuleById,
} from '$lib/server/llm/llm-client'
import type { ResolvedLlmConfig } from '$lib/server/llm/types'

export type ProviderTestResult =
  | { ok: true; model: string; latencyMs: number }
  | { ok: false; error: string }

const PROVIDER_TEST_TIMEOUT_MS = 15_000

/**
 * Config-driven routing for the pre-save provider test: the credentials under test must
 * stand alone (deployment env must not silently complete them).
 */
async function routingConfigForTest(config: ResolvedLlmConfig): Promise<{ model: string; ruleId?: string }> {
  if (config.provider === 'eurouter') {
    const ruleId = config.ruleChat?.trim()
    if (ruleId) {
      const resolved = await resolveRoutingRuleById(ruleId, config.apiKey, config.baseUrl)
      return { model: resolved.model, ruleId }
    }
    const model = config.modelChat?.trim()
    if (model) return { model }
    throw new Error('No chat routing rule or model configured for this EUrouter credential.')
  }

  const model = config.modelChat?.trim()
  if (!model) {
    throw new Error('No chat model configured for this OpenRouter credential.')
  }
  return { model }
}

/**
 * Proves a provider credential actually works BEFORE it is saved: one real 1-token chat
 * completion against the gateway, single attempt (a test must be fast, not retried),
 * activity-logged like every other gateway call so the cost shows up.
 */
export async function testLlmProviderConnection(
  userId: string,
  config: ResolvedLlmConfig,
): Promise<ProviderTestResult> {
  const db = getDb()
  const activityProvider = activityProviderForLlmConfig(config.provider)
  const gatewayHost = gatewayHostFromBaseUrl(config.baseUrl)
  const startedAt = Date.now()

  try {
    const routing = await routingConfigForTest(config)
    const res = usesApiShape(config.provider)
      ? await fetchProviderChatCompletion(config, {
          model: routing.model,
          messages: [{ role: 'user', content: 'ping' }],
          maxTokens: 1,
        })
      : await fetch(`${config.baseUrl}/chat/completions`, {
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        ...(routing.ruleId ? { rule_id: routing.ruleId } : {}),
        model: routing.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      }),
    })

    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text) as unknown
    } catch {
      json = { raw: text }
    }

    const latencyMs = Date.now() - startedAt
    if (!res.ok) {
      const detail =
        typeof json === 'object' && json && 'error' in json
          ? JSON.stringify((json as { error?: unknown }).error)
          : text.slice(0, 300)
      await logActivityCall(db, userId, {
        provider: activityProvider,
        gatewayHost,
        operation: 'llm.chat.provider-test.error',
        baseCostUsd: 0,
        context: 'provider connection test',
        errorMessage: `HTTP ${res.status}: ${detail}`,
        durationMs: latencyMs,
      })
      return { ok: false, error: `Provider test failed (HTTP ${res.status}): ${detail}` }
    }

    await logActivityCall(db, userId, {
      provider: activityProvider,
      gatewayHost,
      operation: 'llm.chat.provider-test.success',
      baseCostUsd: gatewayReportedCostUsdForLog(json),
      context: 'provider connection test',
      durationMs: latencyMs,
    })
    return { ok: true, model: routing.model, latencyMs }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Provider test failed: ${message}` }
  }
}
