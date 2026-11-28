import { EIGEN_INFERENCE } from '$lib/ai/eigen-inference'
import { MODEL_POOL } from './model-pool'

/**
 * The server side of {@link EIGEN_INFERENCE} (wish 60bd7be2): what people and the agent are told
 * on eigenInference. Structure only: known identifiers (the pool's model ids and routes, the
 * pool providers' names and hosts) are replaced as written; nothing here reads meaning.
 */

export type ChatModelFacing = {
  provider: string
  model: string
  routingRuleId: string | null
  billing: 'byok' | 'platform'
  gatewayHost: string
}

/** kernel.whoami's model: on eigenInference only "eigenInference"; on the own key as resolved. */
export function facingChatModel(d: ChatModelFacing): ChatModelFacing {
  if (d.billing !== 'platform') return d
  return { provider: EIGEN_INFERENCE, model: EIGEN_INFERENCE, routingRuleId: null, billing: 'platform', gatewayHost: EIGEN_INFERENCE }
}

/** The pool providers as an error may name them (labels, hosts). */
export const POOL_PROVIDER_NAMES: readonly string[] = ['openrouter.ai', 'api.opper.ai', 'opper.ai', 'OpenRouter', 'Opper']

/** Every id the pool's models go by: pool ids, provider routes, and the name after the namespace. */
export function poolModelIdentifiers(): string[] {
  const ids = new Set<string>()
  for (const m of MODEL_POOL) {
    for (const id of [m.id, ...Object.values(m.routes)]) {
      if (!id) continue
      ids.add(id)
      const bare = id.replace(/^~/, '')
      ids.add(bare)
      const slash = bare.lastIndexOf('/')
      if (slash > 0 && bare.length - slash > 4) ids.add(bare.slice(slash + 1))
    }
  }
  return [...ids]
}

/** An error's sentence as a company on eigenInference reads it: no model id, no provider name. */
export function facingErrorMessage(
  message: string,
  opts: { eigenInference: boolean; modelIds?: readonly string[]; providerNames?: readonly string[] },
): string {
  if (!opts.eigenInference) return message
  const names = [...(opts.modelIds ?? poolModelIdentifiers()), ...(opts.providerNames ?? POOL_PROVIDER_NAMES)]
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length)
  let out = message
  for (const name of names) out = out.split(name).join(EIGEN_INFERENCE)
  return out
}
