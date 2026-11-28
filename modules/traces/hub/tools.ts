import type { ToolDescriptor } from '$lib/kernel/types'
import { TRACE_HUB_MODULE_ID } from './manifest'
import { getInput, hubGetTrace, hubListRuns, hubReleaseHealth, hubStats, listInput, releaseHealthInput, statsInput, type TraceHubDeps } from './service'

/**
 * trace_hub.* kernel tools: how the makers (and their agent, over MCP) read what every box
 * shared — failure rate, p95 and cost by tool/model/version/day, runs by outcome, one run's
 * span tree. Read-only; usage statistics only, never content.
 */

type ReadDeps = Pick<TraceHubDeps, 'store' | 'now'>

async function liveDeps(): Promise<ReadDeps> {
  const { traceHubReadDeps } = await import('./live')
  return traceHubReadDeps()
}

export function createTraceHubTools(opts: { deps?: () => Promise<ReadDeps> } = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  return [
    {
      name: 'trace_hub.stats',
      module: TRACE_HUB_MODULE_ID,
      summary:
        'Product signals of every box, grouped by tool | model | log_context | app_version | day | kind | error_code over the last `days`: spans, errors, error rate, installs, p50/p95 duration (ms), tokens in/out, cost (USD). Optional `kind` (run|llm_call|tool_call|job|upgrade|module_run).',
      auditClass: 'read',
      inputSchema: statsInput,
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (_ctx, input) => hubStats(await deps(), statsInput.parse(input)),
    },
    {
      name: 'trace_hub.list',
      module: TRACE_HUB_MODULE_ID,
      summary: 'Runs (root spans) every box shared, newest first; filter by outcome (ok|error|stopped|rolled_back), error_code, app_version.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (_ctx, input) => hubListRuns(await deps(), listInput.parse(input)),
    },
    {
      name: 'trace_hub.get',
      module: TRACE_HUB_MODULE_ID,
      summary: 'One run’s span tree (install_id + trace_id from trace_hub.list): every model and tool call with its offset, duration and outcome.',
      auditClass: 'read',
      inputSchema: getInput,
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (_ctx, input) => hubGetTrace(await deps(), getInput.parse(input)),
    },
    {
      name: 'trace_hub.release_health',
      module: TRACE_HUB_MODULE_ID,
      summary: 'Whether a release’s rollout wave halts: how many boxes rolled it back and how many company modules were switched off as failed on boxes running it (halt = any).',
      auditClass: 'read',
      inputSchema: releaseHealthInput,
      permission: { roles: ['owner', 'admin', 'agent'] },
      handler: async (_ctx, input) => hubReleaseHealth(await deps(), releaseHealthInput.parse(input)),
    },
  ]
}
