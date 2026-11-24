import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { MODULE_LOG_LINES } from '../../contracts/module-workload'
import { COMPANY_MODULES_MODULE_ID } from './manifest'
import type { CompanyModules } from './service'

/**
 * The `modules.*` registry tools (plan/phase-upgrades-u2.md §8). Settings →
 * Modules, the CLI, MCP and the assistant all use these; the module host does
 * the running. Module code is public (Apache-2.0, shared with
 * eigenEnterprise): the summaries say so where it matters.
 */

const id = z.string().min(2).max(24).describe('The module id (lowercase words joined by "-").')
const commit = z.string().regex(/^[0-9a-f]{40}$/).describe('A full 40-hex commit of the module repo.')
const path = z.string().min(1).max(512).describe('A path inside the module folder, e.g. "tools.ts".')

const idInput = z.object({ id })
const sourceInput = z.object({ id, commit: commit.optional(), path: path.optional() })
const logsInput = z.object({ id, lines: z.number().int().min(1).max(MODULE_LOG_LINES.max).optional() })
const scaffoldInput = z.object({
  id,
  name: z.string().min(1).max(60).describe('The module name people see.'),
  description: z.string().min(1).max(300).describe('One sentence: what it does.'),
})
const writeInput = z.object({ id, path, content: z.string().max(1024 * 1024) })
const deleteInput = z.object({ id, path })
const commitInput = z.object({ id, message: z.string().min(1).max(500) })
const atCommitInput = z.object({ id, commit })

const READ = ['admin', 'member', 'agent']
const BUILD = ['admin', 'agent']
const short = (c: string) => c.slice(0, 12)

/** Gated by the owner's approval mode (APPROVAL_REQUIRED_TOOLS). */
export const COMPANY_MODULES_GATED_TOOLS = ['modules.deploy'] as const

export function createCompanyModulesTools(service: () => Promise<CompanyModules>): ToolDescriptor[] {
  const m = COMPANY_MODULES_MODULE_ID
  return [
    {
      name: 'modules.list',
      module: m,
      summary:
        "The company's own modules: each one's state (running, failed, off, …), why in a sentence, its version, commit and owner; and whether the owner gave the one-time sharing OK.",
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: { roles: READ },
      handler: async () => (await service()).list(),
    },
    {
      name: 'modules.get',
      module: m,
      summary: "One company module: its manifest, deployed commit and receipt, the module hub it was published to, its published commits and the sentence on why it isn't running (if so).",
      auditClass: 'read',
      inputSchema: idInput,
      permission: { roles: READ },
      handler: async (_ctx, input) => (await service()).get(idInput.parse(input).id),
    },
    {
      name: 'modules.status',
      module: m,
      summary: "A company module's live status: ee's view of its unit (state, restarts, releases) and the kernel's session (connected, ready, last heartbeat).",
      auditClass: 'read',
      inputSchema: idInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => (await service()).status(idInput.parse(input).id),
    },
    {
      name: 'modules.logs',
      module: m,
      summary: "The last lines a company module's process wrote (redacted by ee). Default 200.",
      auditClass: 'read',
      inputSchema: logsInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const p = logsInput.parse(input)
        return (await service()).logs(p.id, p.lines ?? MODULE_LOG_LINES.default)
      },
    },
    {
      name: 'modules.source',
      module: m,
      summary:
        "A company module's code: without path, its file tree; with path, one file's text. At a commit, or the working tree (uncommitted edits included) without one.",
      auditClass: 'read',
      inputSchema: sourceInput,
      permission: { roles: READ },
      handler: async (_ctx, input) => {
        const p = sourceInput.parse(input)
        return (await service()).source(p.id, p.commit, p.path)
      },
    },
    {
      name: 'modules.scaffold',
      module: m,
      summary:
        'Start a new company module: module.yaml, the Apache-2.0 LICENSE, the vendored SDK, one tool and a passing test, committed. The calling person owns it on this box. Module code is open source and shared with eigenEnterprise once published.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof scaffoldInput>) => `Started the module ${input.name}`,
      inputSchema: scaffoldInput,
      permission: { roles: BUILD },
      handler: async (ctx, input) => (await service()).scaffold(ctx.principal, scaffoldInput.parse(input)),
    },
    {
      name: 'modules.write_file',
      module: m,
      summary:
        "Write one file of a company module (inside its folder only; never node_modules, .git, .env files or keys). Uncommitted until modules.commit. Module code is public: no secrets or private data in it.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof writeInput>) => `Wrote ${input.path} of the module ${input.id}`,
      inputSchema: writeInput,
      permission: { roles: BUILD },
      handler: async (_ctx, input) => {
        const p = writeInput.parse(input)
        return (await service()).writeFile(p.id, p.path, p.content)
      },
    },
    {
      name: 'modules.delete_file',
      module: m,
      summary: 'Delete one file of a company module (inside its folder only). Uncommitted until modules.commit.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof deleteInput>) => `Deleted ${input.path} of the module ${input.id}`,
      inputSchema: deleteInput,
      permission: { roles: BUILD },
      handler: async (_ctx, input) => {
        const p = deleteInput.parse(input)
        return (await service()).deleteFile(p.id, p.path)
      },
    },
    {
      name: 'modules.commit',
      module: m,
      summary: "Commit a company module's folder as the calling person; returns the commit (to publish, test or deploy).",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof commitInput>, output?: { commit: string }) =>
        output ? `Committed the module ${input.id} (${short(output.commit)})` : `Committed the module ${input.id}`,
      inputSchema: commitInput,
      permission: { roles: BUILD },
      handler: async (ctx, input) => {
        const p = commitInput.parse(input)
        return (await service()).commit(ctx.principal, p.id, p.message)
      },
    },
    {
      name: 'modules.publish',
      module: m,
      summary:
        "Publish a commit of a company module to the module hub, which checks it and answers with a signed receipt (ee runs only receipted code). The code becomes open source (Apache-2.0) and shared with eigenEnterprise. Needs the owner's one-time sharing OK.",
      auditClass: 'external',
      activity: (input: z.infer<typeof atCommitInput>) => `Published the module ${input.id} (${short(input.commit)})`,
      inputSchema: atCommitInput,
      permission: { roles: BUILD },
      handler: async (ctx, input) => {
        const p = atCommitInput.parse(input)
        const v = await (await service()).publish(ctx.principal, p.id, p.commit)
        return { id: v.moduleId, commit: v.commit, version: v.version, bundleSha256: v.bundleSha256, receipt: v.receipt }
      },
    },
    {
      name: 'modules.test',
      module: m,
      summary: "Build and test a commit of a company module the way ee runs it (no network, no secrets), publishing it first if needed. Runs nothing.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof atCommitInput>, output?: { passed: boolean }) =>
        output
          ? `Tested the module ${input.id} (${short(input.commit)}): ${output.passed ? 'passed' : 'failed'}`
          : `Tested the module ${input.id} (${short(input.commit)})`,
      inputSchema: atCommitInput,
      permission: { roles: BUILD },
      handler: async (ctx, input) => {
        const p = atCommitInput.parse(input)
        return (await service()).test(ctx.principal, p.id, p.commit)
      },
    },
    {
      name: 'modules.deploy',
      module: m,
      summary:
        "Run a published commit of a company module (stop-then-start). A first deploy, or one that widens what it uses, its permissions or who may call its tools, needs an admin's own click: anyone else gets module_needs_admin_click and the admins see it in Needs you. While a person has the module switched off, the commit is recorded and nothing starts.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof atCommitInput>) => `Deployed the module ${input.id} (${short(input.commit)})`,
      inputSchema: atCommitInput,
      permission: { roles: BUILD },
      handler: async (ctx, input) => {
        const p = atCommitInput.parse(input)
        return (await service()).deploy(ctx.principal, p.id, p.commit)
      },
    },
    {
      name: 'modules.remove',
      module: m,
      summary: "Remove a company module from this box: its tools go and ee removes its unit. Its code (module repo, hub) and its data (extensions/<id>/) stay. An admin at their own keyboard; always asks.",
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      approvalAlways: true,
      activity: (input: z.infer<typeof idInput>) => `Removed the module ${input.id}`,
      inputSchema: idInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => (await service()).remove(ctx.principal, idInput.parse(input).id),
    },
    {
      name: 'modules.accept_sharing',
      module: m,
      summary:
        'The owner\'s one-time OK: "Modules you build here are open source (Apache-2.0) and shared with eigenEnterprise." Until then nothing is published. The owner at their own keyboard only.',
      auditClass: 'mutate',
      approvalRisk: 'public',
      activity: () => 'Agreed that the modules built here are open source and shared with eigenEnterprise',
      inputSchema: z.object({}),
      permission: { roles: ['admin'] },
      handler: async (ctx) => (await service()).acceptSharing(ctx.principal),
    },
  ]
}
