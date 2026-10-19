import type { GitHubApi, Repo } from './api'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { EeClient, type EeTransport } from '$lib/server/ee/client'
import { githubAppJwt } from './jwt'
import { GITHUB_TOOL_NAMES } from './manifest'
import { InMemoryGitHubStore } from './store'
import { createGitHubTools } from './tools'

const human: ToolContext = { principal: { id: 'u1', kind: 'human', roles: ['admin'] }, requestId: 'r' }
const agent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'r' }
const webhook: ToolContext = { principal: { id: 'github-webhook', kind: 'service', roles: ['service'] }, requestId: 'r' }
const REV = 'c'.repeat(40)

function setup() {
  const store = new InMemoryGitHubStore()
  store.conn = { appId: 7, appSlug: 'eigen-kindred', clientId: 'cid', htmlUrl: 'https://github.com/apps/eigen-kindred', installationId: 99 }
  store.creds = { privateKeyPem: 'pem', webhookSecret: 'whs', clientSecret: 'cs' }
  const repos: Repo[] = [{ full_name: 'kindred/app', default_branch: 'main', private: true, clone_url: '' }]
  const api = {
    installationToken: async (appId: number, _pem: string, inst: number) => `tok-${appId}-${inst}`,
    installationRepos: async () => repos,
  } as unknown as GitHubApi
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const transport: EeTransport = async (method, path, body) => {
    calls.push({ method, path, body: body as Record<string, unknown> })
    if (path === '/v1/sources/fetch') return { status: 200, data: { mirror: 'sources/gh-app1.git', ref: 'main', rev: REV } }
    return { status: 200, data: { rev: 'state-rev', reconcileError: null } }
  }
  const tools = new Map(createGitHubTools({ store, api, ee: new EeClient(transport) }).map((t) => [t.name, t]))
  return { store, calls, tools }
}

describe('github module', () => {
  it('builds exactly the manifest tools', () => {
    expect([...setup().tools.keys()].sort()).toEqual([...GITHUB_TOOL_NAMES].sort())
  })

  it('app_create: fetches with the installation token, pins the commit, creates the app as the human', async () => {
    const { calls, tools, store } = setup()
    const out = await tools.get('github.app_create')!.handler(human, { name: 'app1', repo: 'kindred/app' })
    expect(calls[0]).toMatchObject({ path: '/v1/sources/fetch', body: { name: 'gh-app1', url: 'https://github.com/kindred/app.git', ref: 'main', token: 'tok-7-99' } })
    expect(calls[1]).toMatchObject({
      path: '/v1/apps',
      body: { name: 'app1', source: { kind: 'git', mirror: 'sources/gh-app1.git', ref: 'main', rev: REV }, author: 'human:u1' },
    })
    expect(out).toMatchObject({ commit: REV, stateRev: 'state-rev', reconcileError: null })
    expect(await store.link('app1')).toEqual({ workload: 'app1', repoFullName: 'kindred/app', ref: 'main', autoDeploy: false })
  })

  it('refuses a repo the app cannot see', async () => {
    const { tools } = setup()
    await expect(tools.get('github.app_create')!.handler(human, { name: 'app1', repo: 'someone/else' })).rejects.toThrow(/cannot see/)
  })

  it('the agent cannot create or deploy apps (D11)', async () => {
    const { tools, calls } = setup()
    await expect(tools.get('github.app_create')!.handler(agent, { name: 'app1', repo: 'kindred/app' })).rejects.toBeInstanceOf(KernelError)
    await expect(tools.get('github.app_deploy')!.handler(agent, { name: 'app1' })).rejects.toBeInstanceOf(KernelError)
    expect(calls).toEqual([])
  })

  it('auto_deploy only touches linked apps that opted in', async () => {
    const { tools, store, calls } = setup()
    await store.saveLink({ workload: 'on', repoFullName: 'kindred/app', ref: 'main', autoDeploy: true })
    await store.saveLink({ workload: 'off', repoFullName: 'kindred/app', ref: 'main', autoDeploy: false })
    const out = (await tools.get('github.auto_deploy')!.handler(webhook, { repo: 'kindred/app', ref: 'main', after: REV })) as {
      deployed: Array<{ name: string }>
    }
    expect(out.deployed.map((d) => d.name)).toEqual(['on'])
    expect(calls.filter((c) => c.path === '/v1/deploy').map((c) => c.body.workload)).toEqual(['on'])
    await expect(tools.get('github.auto_deploy')!.handler(human, { repo: 'kindred/app', ref: 'main', after: REV })).rejects.toBeInstanceOf(KernelError)
  })

  it('reports an uninstalled app explicitly', async () => {
    const { tools, store } = setup()
    store.conn = { ...store.conn!, installationId: null }
    await expect(tools.get('github.repos_list')!.handler(human, {})).rejects.toThrow(/not installed/)
  })
})

describe('githubAppJwt', () => {
  it('is a valid RS256 JWT for the app, backdated for drift', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ format: 'pem', type: 'pkcs1' }).toString()
    const now = new Date('2026-10-19T12:00:00Z')
    const [h, p, s] = githubAppJwt(42, pem, now).split('.')
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString())
    expect(payload).toEqual({ iss: '42', iat: now.getTime() / 1000 - 60, exp: now.getTime() / 1000 - 60 + 540 })
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
  })
})
