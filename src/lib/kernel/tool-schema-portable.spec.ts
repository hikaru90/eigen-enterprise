import { describe, expect, it, vi } from 'vitest'

// Hermetic: building the registry reads tool descriptors only; no handler, env or DB is touched.
vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { agentAdminManifest, createAgentAdminTools } from '$lib/kernel/agent-admin'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import { InMemoryApprovalModeStore, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { toolInputJsonSchema } from '$lib/kernel/openapi'
import type { SettingsPort } from '$lib/kernel/settings-tools'
import { registerModuleTools } from '$lib/kernel/wiring'
import { buildKernel } from '../../../modules/index'

/**
 * Every tool's input schema is sent to the model as an OpenAI `tools` entry. Providers
 * that decode tool calls against a grammar (vLLM/xgrammar, e.g. OpenRouter's
 * OpenInference) refuse the WHOLE request when a `pattern` uses regex features outside
 * a regular grammar — lookahead/lookbehind and backreferences. On the demo company
 * (2026-11-23) every chat turn routed there failed with HTTP 400 because of one
 * lookahead in the hostname pattern. Length limits belong in maxLength instead.
 */
const NON_REGULAR = [
  { what: 'lookahead/lookbehind', re: /\(\?<?[=!]/ },
  { what: 'backreference', re: /\\[1-9]|\\k</ },
]

function patternsOf(
  schema: unknown,
  path: string,
  out: Array<{ path: string; pattern: string }>,
): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => patternsOf(item, `${path}[${i}]`, out))
    return
  }
  if (!schema || typeof schema !== 'object') return
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'pattern' && typeof value === 'string') out.push({ path, pattern: value })
    else patternsOf(value, `${path}.${key}`, out)
  }
}

async function productionTools() {
  const kernel = buildKernel({
    activations: new InMemoryActivationStore(),
    eventSink: new InMemoryEventSink(),
    approvalStore: new InMemoryApprovalStore(),
    approvalMode: new InMemoryApprovalModeStore('ask'),
    vcsCommitter: null,
  })
  const notInAListing = async (): Promise<never> => {
    throw new Error('the schema gate never calls the settings port')
  }
  const settings: SettingsPort = {
    modelFor: notInAListing,
    person: notInAListing,
    read: notInAListing,
    apply: notInAListing,
  }
  await registerAdminTools(kernel, { settings })
  kernel.modules.register(agentAdminManifest)
  registerModuleTools(
    kernel.registry,
    kernel.modules,
    createAgentAdminTools({ runtime: {} as AgentRuntime }),
  )
  return kernel.registry.list()
}

describe('tool input schemas are portable to grammar-constrained providers', () => {
  it('no registry tool sends a pattern with lookaround or backreferences', async () => {
    const tools = await productionTools()
    expect(tools.length).toBeGreaterThan(100)
    const offenders: string[] = []
    for (const tool of tools) {
      const found: Array<{ path: string; pattern: string }> = []
      patternsOf(toolInputJsonSchema(tool.inputSchema), '', found)
      for (const { path, pattern } of found) {
        for (const { what, re } of NON_REGULAR) {
          if (re.test(pattern)) offenders.push(`${tool.name}${path}: ${what} in ${pattern}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
