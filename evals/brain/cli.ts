import type { SuiteItem } from './types'
import { ALL_ITEMS } from './suites'

/** `suite`: 'all' (the brain items + the co-workers suite) or 'coworkers' (C8 alone). */
export type BrainEvalArgs = { mode: 'static' | 'chat'; provider: 'platform' | 'mock' | null; only: string[] | null; suite: 'all' | 'coworkers' }

export const BRAIN_EVAL_USAGE = [
  'npm run eval:brain                                   # static: no model, tool-level Keeps + Knows reachability',
  'npm run eval:brain -- --mode chat --provider mock      # the real chat path against the e2e mock gateway (runner check)',
  'npm run eval:brain -- --mode chat --provider platform  # real model (PLATFORM_LLM_* set): the per-release baseline',
  '  --only K01,L03                                       # a subset of items',
  '  --suite coworkers                                    # the AI co-workers suite alone (C8: Keeps, Does with --provider mock, Different with --provider platform)',
].join('\n')

export function parseBrainEvalArgs(argv: string[]): BrainEvalArgs {
  let mode: string | null = null
  let provider: string | null = null
  let only: string[] | null = null
  let suite: string = 'all'
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') continue
    const value = argv[i + 1]
    if (a === '--mode' && value) {
      mode = value
      i += 1
    } else if (a === '--provider' && value) {
      provider = value
      i += 1
    } else if (a === '--suite' && value) {
      suite = value
      i += 1
    } else if (a === '--only' && value) {
      only = value.split(',').map((s) => s.trim()).filter(Boolean)
      i += 1
    } else throw new Error(`unknown argument ${a}\n${BRAIN_EVAL_USAGE}`)
  }
  const m = mode ?? 'static'
  if (m !== 'static' && m !== 'chat') throw new Error(`--mode static|chat, got ${m}`)
  if (m === 'static' && provider) throw new Error('--provider goes only with --mode chat')
  if (m === 'chat' && provider !== 'platform' && provider !== 'mock') throw new Error('--mode chat needs --provider platform|mock')
  if (suite !== 'all' && suite !== 'coworkers') throw new Error(`--suite all|coworkers, got ${suite}`)
  if (suite === 'coworkers' && only) throw new Error('--only names brain items; --suite coworkers runs none of them')
  for (const id of only ?? []) if (!ALL_ITEMS.some((x) => x.id === id)) throw new Error(`unknown item ${id}`)
  return { mode: m, provider: m === 'chat' ? (provider as 'platform' | 'mock') : null, only, suite }
}

/** Questions first, tasks last: a Does task changes the company (moves a meeting, shares a file). */
export function orderForChat(items: SuiteItem[]): SuiteItem[] {
  const rank = { knows: 0, keeps: 1, does: 2 } as const
  return [...items].sort((a, b) => rank[a.suite] - rank[b.suite])
}

const PLATFORM_KEYS = ['PLATFORM_LLM_BASE_URL', 'PLATFORM_LLM_API_KEY', 'PLATFORM_LLM_MODEL_CHAT', 'PLATFORM_LLM_MODEL_EMBEDDING'] as const

/**
 * The app env that selects the model. Both providers use the hosted-box
 * platform AI contract (src/lib/server/llm/platform-ai.ts, eigenInference's
 * precursor): one credential for every member, so the run measures the
 * brain, not per-person key setup.
 */
export function providerEnvFor(provider: 'platform' | 'mock', env: Record<string, string | undefined>, mockOrigin: string | null): Record<string, string> {
  if (provider === 'mock') {
    if (!mockOrigin) throw new Error('the mock provider needs the mock gateway’s origin')
    return { PLATFORM_LLM_BASE_URL: `${mockOrigin}/v1`, PLATFORM_LLM_API_KEY: 'mock', PLATFORM_LLM_MODEL_CHAT: 'mock-chat-model', PLATFORM_LLM_MODEL_EMBEDDING: 'mock-embed-model' }
  }
  const missing = PLATFORM_KEYS.filter((k) => !env[k]?.trim())
  if (missing.length > 0) {
    throw new Error(`--provider platform needs a real model: set ${missing.join(', ')} (the hosted-box platform AI contract; all four). Nothing is measured without one.`)
  }
  return Object.fromEntries(PLATFORM_KEYS.map((k) => [k, env[k]!.trim()]))
}
