import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { SubstrateError, SubstrateUnavailableError } from '$lib/server/ee/client'
import { GitHubApi } from '$lib/server/github/api'
import { GitHubUserError } from '$lib/server/github/plain-errors'
import { createGitHubConnectTools, type DeployKeyEe } from './connect-tools'
import { InMemoryConnectedRepoStore } from './repos-store'
import { InMemoryGitHubStore } from './store'

const human: ToolContext = {
  principal: { id: 'u1', kind: 'human', roles: ['admin'] },
  requestId: 'r',
}
const agent: ToolContext = {
  principal: { id: 'a1', kind: 'agent', roles: ['agent'] },
  requestId: 'r',
}

/** ee's deploy-key verbs, in memory. Holds no private key: the real one never leaves ee. */
class FakeEe implements DeployKeyEe {
  keys = new Map<string, string>()
  accepted = new Set<string>()
  deleted: string[] = []
  unavailable = false
  private n = 0
  private guard() {
    if (this.unavailable) throw new SubstrateUnavailableError('ENOENT')
  }
  async createDeployKey(i: { repo: string; author: string }) {
    this.guard()
    const keyId = `dk_${String(++this.n).padStart(24, '0')}`
    this.keys.set(keyId, i.repo)
    return { keyId, publicKey: `ssh-ed25519 AAAAPUB${this.n} ee-deploy-${i.repo}` }
  }
  async checkDeployKey(keyId: string, i: { repo: string }) {
    this.guard()
    if (this.keys.get(keyId) !== i.repo)
      throw new SubstrateError(500, `deploy key ${keyId} belongs to another repo`)
    return this.accepted.has(keyId)
      ? { ok: true as const, branches: ['dev', 'main'] }
      : {
          ok: false as const,
          error: 'not_accepted' as const,
          detail: 'git@github.com: Permission denied (publickey).',
        }
  }
  async deleteDeployKey(keyId: string) {
    this.guard()
    if (!this.keys.delete(keyId)) throw new SubstrateError(404, `no deploy key ${keyId}`)
    this.deleted.push(keyId)
    return { ok: true as const }
  }
}

function setup() {
  const seen: string[] = []
  const api = new GitHubApi((async (input: string | URL) => {
    seen.push(String(input))
    return new Response('{"message":"Not Found"}', { status: 404 })
  }) as typeof fetch)
  const ee = new FakeEe()
  const repos = new InMemoryConnectedRepoStore()
  const tools = new Map(
    createGitHubConnectTools({ github: new InMemoryGitHubStore(), repos, api, ee }).map((t) => [
      t.name,
      t,
    ]),
  )
  const run = (name: string, input: unknown, ctx: ToolContext = human) =>
    tools.get(name)!.handler(ctx, input)
  return { tools, repos, ee, run, seen }
}

describe('deploy-key tools: metadata', () => {
  const { tools } = setup()
  it('create is an internal mutation that says what it did; check reads; delete is destructive', () => {
    const create = tools.get('website.github_deploy_key_create')!
    expect([create.auditClass, create.approvalRisk]).toEqual(['mutate', 'internal'])
    expect(create.activity!({ repo: 'git@github.com:kindred/secret.git' }, undefined)).toBe(
      'Created a deploy key for kindred/secret',
    )
    expect(tools.get('website.github_deploy_key_check')!.auditClass).toBe('read')
    const del = tools.get('website.github_deploy_key_delete')!
    expect([del.auditClass, del.approvalRisk]).toEqual(['mutate', 'destructive'])
    expect(del.activity!({ repo: 'kindred/secret', keyId: 'dk_x' }, undefined)).toBe(
      'Deleted the deploy key for kindred/secret',
    )
  })
})

describe('connect a private repo with a deploy key', () => {
  it('create (owner click) returns the public key and the GitHub page to add it on', async () => {
    const { run } = setup()
    const out = await run('website.github_deploy_key_create', {
      repo: 'git@github.com:kindred/secret.git',
    })
    expect(out).toEqual({
      repo: 'kindred/secret',
      keyId: expect.stringMatching(/^dk_/),
      publicKey: expect.stringMatching(/^ssh-ed25519 /),
      addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
    })
  })

  it('D11: the agent cannot create or delete a key on the server', async () => {
    const { run } = setup()
    await expect(
      run('website.github_deploy_key_create', { repo: 'kindred/secret' }, agent),
    ).rejects.toMatchObject({
      code: 'permission_denied',
    })
    await expect(
      run(
        'website.github_deploy_key_delete',
        { repo: 'kindred/secret', keyId: 'dk_' + '0'.repeat(24) },
        agent,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('without ee it fails loud in plain words, with no fallback', async () => {
    const { run, ee } = setup()
    ee.unavailable = true
    const err = await run('website.github_deploy_key_create', { repo: 'kindred/secret' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(GitHubUserError)
    expect((err as Error).message).toBe(
      "Private repos need the server's deploy agent. This copy of Eigen Enterprise is not running on a server set up with ee, so it cannot hold a deploy key.",
    )
  })

  it('check before the key is on GitHub: a plain message, never the ssh output', async () => {
    const { run } = setup()
    const { keyId } = (await run('website.github_deploy_key_create', {
      repo: 'kindred/secret',
    })) as { keyId: string }
    const out = await run('website.github_deploy_key_check', { repo: 'kindred/secret', keyId })
    expect(out).toEqual({
      ok: false,
      message:
        "GitHub didn't accept the key yet — check it was added to this repo (Settings → Deploy keys).",
    })
    expect(JSON.stringify(out)).not.toMatch(/Permission denied|publickey/)
  })

  it('check → branches; connect stores auth kind and key id only; disconnect deletes the key in ee', async () => {
    const { run, ee, repos, seen } = setup()
    const { keyId } = (await run('website.github_deploy_key_create', {
      repo: 'kindred/secret',
    })) as { keyId: string }
    ee.accepted.add(keyId)
    expect(await run('website.github_deploy_key_check', { repo: 'kindred/secret', keyId })).toEqual(
      {
        ok: true,
        branches: ['dev', 'main'],
      },
    )

    await expect(
      run('website.github_connect_repo', {
        repo: 'kindred/secret',
        branch: 'nope',
        auth: { kind: 'deploy_key', keyId },
      }),
    ).rejects.toThrow('kindred/secret has no branch named “nope”.')
    await run('website.github_connect_repo', {
      repo: 'https://github.com/kindred/secret',
      branch: 'main',
      auth: { kind: 'deploy_key', keyId },
    })
    expect(repos.rows).toMatchObject([
      {
        repoId: null,
        fullName: 'kindred/secret',
        branch: 'main',
        htmlUrl: 'https://github.com/kindred/secret',
        cloneUrl: 'git@github.com:kindred/secret.git',
        visibility: 'private',
        authKind: 'deploy_key',
        deployKeyId: keyId,
        installationId: null,
      },
    ])
    expect(JSON.stringify(repos.rows)).not.toContain('ssh-ed25519')

    const listed = (await run('website.github_list_repos', {})) as {
      repos: Array<Record<string, unknown>>
    }
    expect(listed.repos[0]).toMatchObject({
      authKind: 'deploy_key',
      lastCommit: null,
      lastCommitError: 'Read through a deploy key; the latest commit shows once it is deployed.',
    })
    expect(seen).toEqual([]) // a deploy-key repo is never looked up through the GitHub API

    await expect(
      run('website.github_deploy_key_delete', { repo: 'kindred/secret', keyId }),
    ).rejects.toThrow('kindred/secret (main) uses this key. Disconnect it instead.')

    await expect(
      run('website.github_disconnect_repo', { repo: 'kindred/secret', branch: 'main' }, agent),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    const removed = await run('website.github_disconnect_repo', {
      repo: 'kindred/secret',
      branch: 'main',
    })
    expect(removed).toMatchObject({
      fullName: 'kindred/secret',
      removeKeyUrl: 'https://github.com/kindred/secret/settings/keys',
    })
    expect(ee.deleted).toEqual([keyId])
    expect(repos.rows).toEqual([])
  })

  it('connect refuses a key GitHub does not accept yet, plainly', async () => {
    const { run, repos } = setup()
    const { keyId } = (await run('website.github_deploy_key_create', {
      repo: 'kindred/secret',
    })) as { keyId: string }
    await expect(
      run('website.github_connect_repo', {
        repo: 'kindred/secret',
        branch: 'main',
        auth: { kind: 'deploy_key', keyId },
      }),
    ).rejects.toThrow(
      "GitHub didn't accept the key yet — check it was added to this repo (Settings → Deploy keys).",
    )
    expect(repos.rows).toEqual([])
  })

  it('delete an unused key (owner gives up before connecting)', async () => {
    const { run, ee } = setup()
    const { keyId } = (await run('website.github_deploy_key_create', {
      repo: 'kindred/secret',
    })) as { keyId: string }
    expect(
      await run('website.github_deploy_key_delete', { repo: 'kindred/secret', keyId }),
    ).toEqual({
      ok: true,
      removeKeyUrl: 'https://github.com/kindred/secret/settings/keys',
    })
    expect(ee.deleted).toEqual([keyId])
  })
})
