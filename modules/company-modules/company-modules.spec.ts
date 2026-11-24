import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
// (readdir: the hello fixture's files)
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI } from '../../contracts/fixtures/module-hub-test-key'
import { verifyReceipt } from '../../contracts/module-receipt'
import { InMemorySharingStore } from '$lib/kernel/module-host/memory'
import { moduleNotices } from '$lib/kernel/module-host/notices'
import { HELLO_DIR } from '$lib/kernel/module-host/testing/hello'
import { AGENT, MEMBER, OWNER, testHostKernel, until, type TestHostKernel } from '$lib/kernel/module-host/testing/kernel'
import type { FakeModuleWorkload } from '$lib/kernel/module-host/testing/fake-workload'
import type { ToolContext, ToolPrincipal } from '$lib/kernel/types'
import { createMcpServer } from '$lib/server/mcp/server'
import { parseCliArgs } from '../../src/cli/args'
import { dispatchCommand } from '../../src/cli/commands'
import { companyModulesManifest } from './manifest'
import { ModuleRepo } from './repo'
import { CompanyModules } from './service'
import { FakePublishPort } from './testing/fake-publish'
import { createCompanyModulesTools } from './tools'

/**
 * The box's Modules module end to end (plan/phase-upgrades-u2.md §8, §9
 * Stream A): the modules.* tools over a real module repo, the fake hub
 * (fixture key) and the fake ee that runs the bundle as a child process.
 */

let k: TestHostKernel
let repoDir: string
let hub: FakePublishPort
let sharing: InMemorySharingStore
const ctx = (principal: ToolPrincipal): ToolContext => ({ principal, requestId: 'r' })
const run = (name: string, input: unknown, principal: ToolPrincipal = OWNER) => k.registry.execute(name, input, ctx(principal))

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'module-repo-'))
  const repo = new ModuleRepo(repoDir)
  // Bundles for deploys are rebuilt from the module repo, exactly like live.ts.
  k = await testHostKernel({
    limits: { heartbeatMs: 200, heartbeatMissMs: 2_000 },
    bundles: { bytes: async (id, commit) => (await repo.bundle(id, commit)).bytes },
  })
  hub = new FakePublishPort()
  sharing = new InMemorySharingStore()
  const service = new CompanyModules({
    host: k.host,
    store: k.store,
    sharing,
    repo,
    publish: hub,
    workload: k.workload,
    eventSink: k.eventSink,
    coreTools: () => k.registry.list().map((t) => t.name),
    authorOf: async (id) => ({ name: `Person ${id}`, email: `${id}@test.local` }),
    isOwner: async (id) => id === OWNER.id,
  })
  // hello's uses.tools names members.list: the box must have it.
  k.modules.register({ id: 'members', name: 'Members', version: '1.0.0', tools: ['members.list'], permissions: { roles: ['admin'] } })
  k.registry.register({
    name: 'members.list',
    module: 'members',
    summary: 'List members',
    inputSchema: z.object({}),
    permission: { roles: ['admin', 'member', 'agent'] },
    auditClass: 'read',
    handler: async () => ({ members: [] }),
  })
  k.modules.register(companyModulesManifest)
  await k.activations.set('company-modules', true)
  for (const tool of createCompanyModulesTools(async () => service)) k.registry.register(tool)
})
afterEach(async () => {
  await k.cleanup()
  await rm(repoDir, { recursive: true, force: true })
})

async function writeHello(): Promise<void> {
  // The hello fixture, written through the tools like the assistant would.
  await run('modules.scaffold', { id: 'hello', name: 'Hello', description: 'Greets a person by name.' }, AGENT)
  const { tree } = (await run('modules.source', { id: 'hello' }, AGENT)) as { tree: { path: string }[] }
  for (const { path } of tree) await run('modules.delete_file', { id: 'hello', path }, AGENT)
  for (const name of await readdir(HELLO_DIR)) {
    await run('modules.write_file', { id: 'hello', path: name, content: await readFile(join(HELLO_DIR, name), 'utf8') }, AGENT)
  }
}

describe('modules.* — scaffold to running', () => {
  it('a scaffolded module (vendored SDK, type-stripped) is published, gated on the sharing OK and the admin click, and runs', async () => {
    const scaffolded = (await run('modules.scaffold', { id: 'greeter', name: 'Greeter', description: 'Says hello.' }, AGENT)) as {
      commit: string
      files: string[]
    }
    expect(scaffolded.files).toEqual(
      expect.arrayContaining(['module.yaml', 'LICENSE', 'test.ts', 'vendor/eigen-sdk/module-runtime.ts', 'vendor/eigen-sdk/test-kernel.ts', 'vendor/eigen-sdk/core-tools.json']),
    )
    expect(await k.store.get('greeter')).toMatchObject({ state: 'unpublished', ownerUserId: AGENT.id })
    // The owner's one-time OK is a Needs you entry once a module exists.
    expect(moduleNotices(await k.store.list(), null, { userId: OWNER.id, isOwner: true, isAdmin: true })).toEqual([
      { kind: 'module_sharing', sentence: 'Modules you build here are open source (Apache-2.0) and shared with eigenEnterprise.' },
    ])

    await expect(run('modules.publish', { id: 'greeter', commit: scaffolded.commit }, AGENT)).rejects.toMatchObject({
      code: 'module_sharing_not_accepted',
    })
    await expect(run('modules.accept_sharing', {}, AGENT)).rejects.toMatchObject({ code: 'human_decision_required' })
    await run('modules.accept_sharing', {}, OWNER)

    const published = (await run('modules.publish', { id: 'greeter', commit: scaffolded.commit }, AGENT)) as {
      receipt: unknown
      bundleSha256: string
    }
    expect(verifyReceipt(published.receipt, [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI]).ok).toBe(true)
    expect(k.eventSink.events.map((e) => e.type)).toContain('module.published')
    // Publishing the same commit again changes nothing.
    await run('modules.publish', { id: 'greeter', commit: scaffolded.commit }, AGENT)
    expect(hub.published).toHaveLength(1)

    // ee's dry run: the scaffold's own test passes.
    const tested = (await run('modules.test', { id: 'greeter', commit: scaffolded.commit }, AGENT)) as { passed: boolean; log: string }
    expect(tested).toMatchObject({ passed: true })
    expect(tested.log).toContain('ok')

    // A first deploy needs an admin's own click.
    await expect(run('modules.deploy', { id: 'greeter', commit: scaffolded.commit }, AGENT)).rejects.toMatchObject({
      code: 'module_needs_admin_click',
    })
    expect(moduleNotices(await k.store.list(), await sharing.get(), { userId: OWNER.id, isOwner: true, isAdmin: true })).toEqual([
      expect.objectContaining({ kind: 'module_deploy_needs_admin', moduleId: 'greeter', commit: scaffolded.commit, by: AGENT.id }),
    ])
    await run('modules.deploy', { id: 'greeter', commit: scaffolded.commit }, OWNER)
    await until(async () => (await k.store.get('greeter'))?.state === 'running', 15_000, 'greeter to run')
    expect((await k.store.get('greeter'))?.pendingDeploy).toBeNull()
    await expect(run('x_greeter.hello', { name: 'Ann' }, MEMBER)).resolves.toEqual({ greeting: 'Hello, Ann!' })

    // A redeploy that widens nothing follows the approval mode: the agent may do it.
    await run('modules.write_file', { id: 'greeter', path: 'NOTES.md', content: 'v2\n' }, AGENT)
    const c2 = (await run('modules.commit', { id: 'greeter', message: 'Notes' }, AGENT)) as { commit: string }
    await run('modules.publish', { id: 'greeter', commit: c2.commit }, AGENT)
    await expect(run('modules.deploy', { id: 'greeter', commit: c2.commit }, AGENT)).resolves.toMatchObject({ widens: [] })
  })

  it('the module repo refuses the files a bundle must never hold, and only inside the folder', async () => {
    await run('modules.scaffold', { id: 'greeter', name: 'Greeter', description: 'Says hello.' }, AGENT)
    for (const path of ['.env', 'node_modules/x.js', 'id_rsa', 'server.pem', '../escape.ts', '/abs.ts']) {
      await expect(run('modules.write_file', { id: 'greeter', path, content: 'x' }, AGENT)).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    await expect(run('modules.write_file', { id: 'nope', path: 'a.ts', content: 'x' }, AGENT)).rejects.toMatchObject({
      code: 'unknown_module',
    })
    await expect(run('modules.scaffold', { id: 'greeter', name: 'Again', description: 'x' }, AGENT)).rejects.toMatchObject({
      code: 'invalid_input',
    })
    const tree = (await run('modules.source', { id: 'greeter' }, MEMBER)) as { tree: { path: string }[] }
    expect(tree.tree.map((e) => e.path)).toContain('module.yaml')
    const file = (await run('modules.source', { id: 'greeter', path: 'tools.ts' }, MEMBER)) as { content: string }
    expect(file.content).toContain('Hello, ')
  })

  it('a stopped hub is hub_unavailable and nothing changes', async () => {
    const s = (await run('modules.scaffold', { id: 'greeter', name: 'Greeter', description: 'Says hello.' }, AGENT)) as { commit: string }
    await run('modules.accept_sharing', {}, OWNER)
    hub.down = true
    await expect(run('modules.publish', { id: 'greeter', commit: s.commit }, AGENT)).rejects.toMatchObject({ code: 'hub_unavailable' })
    expect(await k.store.get('greeter')).toMatchObject({ state: 'unpublished' })
    await expect(run('modules.deploy', { id: 'greeter', commit: s.commit }, OWNER)).rejects.toMatchObject({
      code: 'module_unreceipted',
    })
  })
})

describe('x_hello.greet through the registry, MCP and the CLI', () => {
  it('reaches every surface like any tool', async () => {
    await writeHello()
    const { commit } = (await run('modules.commit', { id: 'hello', message: 'The hello fixture' }, AGENT)) as { commit: string }
    await run('modules.accept_sharing', {}, OWNER)
    await run('modules.publish', { id: 'hello', commit }, AGENT)
    await run('modules.deploy', { id: 'hello', commit }, OWNER)
    await until(async () => (await k.store.get('hello'))?.state === 'running', 15_000, 'hello to run')

    // registry.execute
    await expect(run('x_hello.greet', { name: 'Ann' }, MEMBER)).resolves.toEqual({ greeting: 'Hello, Ann!' })

    // MCP: tools/list carries it, tools/call runs it.
    const server = createMcpServer({ userId: OWNER.id }, { registry: k.registry, activations: k.activations } as never)
    const [a, b] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'spec', version: '0.0.0' })
    await Promise.all([server.connect(a), mcp.connect(b)])
    const listed = await mcp.listTools()
    expect(listed.tools.map((t) => t.name)).toContain('x_hello.greet')
    const called = await mcp.callTool({ name: 'x_hello.greet', arguments: { name: 'Bo' } })
    expect(called.structuredContent).toEqual({ greeting: 'Hello, Bo!' })
    await mcp.close()

    // The CLI's dispatcher (`ee tool run`).
    const outcome = await dispatchCommand(
      { registry: k.registry, activations: k.activations, principal: MEMBER, requestId: 'cli' },
      parseCliArgs(['tool', 'run', 'x_hello.greet', '--input', '{"name":"Cy"}']),
    )
    expect(outcome).toEqual({ exitCode: 0, data: { greeting: 'Hello, Cy!' } })

    // modules.status / modules.logs / modules.get / modules.list
    const status = (await run('modules.status', { id: 'hello' }, AGENT)) as { session: { ready: boolean }; ee: { state: string } }
    expect(status.session.ready).toBe(true)
    expect(status.ee.state).toBe('running')
    expect(((await run('modules.list', {}, MEMBER)) as { modules: { id: string; state: string }[] }).modules).toEqual([
      expect.objectContaining({ id: 'hello', state: 'running', kernelModuleId: 'x-hello' }),
    ])
    expect(await run('modules.get', { id: 'hello' }, MEMBER)).toMatchObject({ commit, hub: 'https://hub.test' })
    expect((k.workload as FakeModuleWorkload).calls.map((c) => c.verb)).toContain('deploy')

    // modules.remove: a person's own click, always asks.
    await expect(run('modules.remove', { id: 'hello' }, AGENT)).rejects.toMatchObject({ code: 'approval_required' })
  })
})
