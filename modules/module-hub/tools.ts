import type { ModuleSummaryDto } from './types'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { MODULE_HUB_MODULE_ID } from './manifest'
import { getHubModule, getHubVersion, hubVersionFile, hubVersionTree, listHubModules, type ModuleHubDeps } from './service'

/**
 * module_hub.* kernel tools (plan/phase-upgrades-u2.md §7): how the owner
 * and the owner's agent read every module installs published — code,
 * versions, the installs running it and its summary — on the hub box
 * (Contribute → Modules, the hub's MCP, `ee module_hub.list`). Summarising
 * again is a mutation (a gateway call that is stored).
 */

const sha = z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex').describe('bundle sha256 (a published version)')
const listInput = z
  .object({
    query: z.string().trim().min(1).max(100).optional().describe('part of a module id or name'),
    cursor: z.string().max(12).optional().describe('the cursor the previous page gave'),
  })
  .strict()
const getInput = z.object({ install_id: z.uuid(), module_id: z.string().min(2).max(24) }).strict()
const shaInput = z.object({ bundle_sha256: sha }).strict()
const fileInput = z.object({ bundle_sha256: sha, path: z.string().min(1).max(1024) }).strict()

export type ModuleHubToolDeps = {
  deps: () => Promise<Pick<ModuleHubDeps, 'store' | 'bundles'>>
  summarize: (bundleSha256: string) => Promise<ModuleSummaryDto>
}

const live: ModuleHubToolDeps = {
  deps: async () => (await import('./live')).moduleHubDeps(),
  summarize: async (s) => (await import('./live')).summarizeNow(s),
}

const READ_ROLES = ['admin', 'agent']

export function createModuleHubTools(opts: Partial<ModuleHubToolDeps> = {}): ToolDescriptor[] {
  const deps = opts.deps ?? live.deps
  const summarize = opts.summarize ?? live.summarize
  return [
    {
      name: 'module_hub.list',
      module: MODULE_HUB_MODULE_ID,
      summary:
        'List the modules eigenEnterprise installs published to the module hub (revoked installs hidden): install_id, module_id, name, description, latest version and bundle, number of versions, first/last published. Most recently published first; pass cursor for the next page.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: READ_ROLES },
      handler: async (_ctx, input) => {
        const i = listInput.parse(input)
        return listHubModules(await deps(), { query: i.query, cursor: i.cursor })
      },
    },
    {
      name: 'module_hub.get',
      module: MODULE_HUB_MODULE_ID,
      summary: 'Read one published module by install_id and module_id: its versions (newest first, with their summaries) and the installs running it.',
      auditClass: 'read',
      inputSchema: getInput,
      permission: { roles: READ_ROLES },
      handler: async (_ctx, input) => {
        const i = getInput.parse(input)
        return getHubModule(await deps(), i.install_id, i.module_id)
      },
    },
    {
      name: 'module_hub.version',
      module: MODULE_HUB_MODULE_ID,
      summary: 'Read one published version by bundle_sha256: its module.yaml, uses, provides, permissions, deprecated uses, size, receipt and summary.',
      auditClass: 'read',
      inputSchema: shaInput,
      permission: { roles: READ_ROLES },
      handler: async (_ctx, input) => getHubVersion(await deps(), shaInput.parse(input).bundle_sha256),
    },
    {
      name: 'module_hub.tree',
      module: MODULE_HUB_MODULE_ID,
      summary: 'List the files of one published version (path, size, mode).',
      auditClass: 'read',
      inputSchema: shaInput,
      permission: { roles: READ_ROLES },
      handler: async (_ctx, input) => hubVersionTree(await deps(), shaInput.parse(input).bundle_sha256),
    },
    {
      name: 'module_hub.file',
      module: MODULE_HUB_MODULE_ID,
      summary: 'Read one file of a published version: its text (up to 256 KB, then truncated), or binary: true with its size.',
      auditClass: 'read',
      inputSchema: fileInput,
      permission: { roles: READ_ROLES },
      handler: async (_ctx, input) => {
        const i = fileInput.parse(input)
        return hubVersionFile(await deps(), i.bundle_sha256, i.path)
      },
    },
    {
      name: 'module_hub.summarize',
      module: MODULE_HUB_MODULE_ID,
      summary: 'Write the summary of a published version again (what it does, what it touches, what it sends out) through the AI gateway, and store it.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof shaInput>) => `Summarised module bundle ${input.bundle_sha256.slice(0, 12)} on the module hub`,
      inputSchema: shaInput,
      permission: { roles: ['admin'] },
      handler: async (_ctx, input) => {
        const s = shaInput.parse(input).bundle_sha256
        return { bundleSha256: s, summary: await summarize(s) }
      },
    },
  ]
}
