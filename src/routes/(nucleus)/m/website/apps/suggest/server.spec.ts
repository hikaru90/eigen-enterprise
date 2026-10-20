import { describe, expect, it, vi } from 'vitest'
import { KernelRegistry } from '$lib/kernel/registry'
import { InMemoryServiceStore } from '../../../../../../../modules/website/apps/store'
import { FakeEe } from '../../../../../../../modules/website/apps/testing'
import { createAppTools } from '../../../../../../../modules/website/apps/tools'
import { InMemoryConnectedRepoStore } from '../../../../../../../modules/website/github/repos-store'

const { holder } = vi.hoisted(() => ({
  holder: { registry: null as unknown, admins: new Set<string>(), answer: '' as string },
}))

// The real requireAdmin runs; only the role lookup is faked.
vi.mock('$lib/server/auth/user-role', () => ({
  isUserAdmin: async (id: string) => holder.admins.has(id),
}))
vi.mock('$lib/server/boot', () => ({ appKernel: async () => ({ registry: holder.registry }) }))
vi.mock('../../../../../../../modules/index', () => ({
  bootstrapKernel: () => ({ registry: holder.registry }),
  ensureSystemModulesActive: async () => undefined,
}))

import { POST } from './+server'

async function setup(answer: string) {
  const ee = new FakeEe()
  ee.tree = { 'README.md': 'node index.js', 'package.json': '{}' }
  const repos = new InMemoryConnectedRepoStore()
  await repos.add({
    repoId: 1,
    fullName: 'heroku/node-js-getting-started',
    branch: 'main',
    htmlUrl: 'https://github.com/heroku/node-js-getting-started',
    cloneUrl: 'https://github.com/heroku/node-js-getting-started.git',
    visibility: 'public',
    authKind: 'public',
    installationId: null,
    deployKeyId: null,
    connectedBy: 'human:u1',
  })
  const registry = new KernelRegistry()
  for (const t of createAppTools({
    ee,
    repos,
    services: new InMemoryServiceStore(),
    mintToken: async () => 'x',
    chat: async () => ({ choices: [{ message: { content: answer } }] }),
  }))
    registry.register(t)
  holder.registry = registry
  holder.admins = new Set(['owner'])
  return { ee }
}

const good = JSON.stringify({
  runtime: 'node@22',
  install: 'npm ci',
  start: 'node index.js',
  healthPath: '/',
  kind: 'web',
  confidence: 0.9,
  reasons: ['README says node index.js'],
  warnings: [],
})

const call = (userId: string | null, body: unknown) =>
  POST({
    locals: { user: userId ? { id: userId } : null },
    request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }),
  } as never)

const input = { name: 'getting-started', repo: 'heroku/node-js-getting-started', branch: 'main' }

describe('POST /m/website/apps/suggest', () => {
  it('returns the suggestion for the owner', async () => {
    await setup(good)
    const res = await call('owner', input)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.suggestion.fields).toMatchObject({ runtime: 'node@22', start: 'node index.js' })
  })

  it('refuses anyone who is not an admin, before reaching ee', async () => {
    const { ee } = await setup(good)
    await expect(call('member', input)).rejects.toMatchObject({ status: 403 })
    await expect(call(null, input)).rejects.toMatchObject({ status: 302 })
    expect(ee.calls).toEqual([])
  })

  it('a failure is a plain sentence, never the raw error', async () => {
    await setup('{"runtime": 42}')
    const res = await call('owner', input)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: expect.stringMatching(/couldn't read the repo well enough/) })

    const bad = await call('owner', { name: 'Not A Name' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).not.toMatch(/zod|regex|invalid_string/i)
  })
})
