import { describe, expect, it } from 'vitest'
import {
  type ConnectedRepoStore,
  InMemoryConnectedRepoStore,
  type NewConnectedRepo,
  RepoAlreadyConnectedError,
} from './repos-store'

export const publicRepo: NewConnectedRepo = {
  repoId: 42,
  fullName: 'kindred/site',
  branch: 'main',
  htmlUrl: 'https://github.com/kindred/site',
  cloneUrl: 'https://github.com/kindred/site.git',
  visibility: 'public',
  authKind: 'public',
  installationId: null,
  deployKeyId: null,
  connectedBy: 'human:u1',
}

export const deployKeyRepo: NewConnectedRepo = {
  repoId: null,
  fullName: 'kindred/secret',
  branch: 'main',
  htmlUrl: 'https://github.com/kindred/secret',
  cloneUrl: 'git@github.com:kindred/secret.git',
  visibility: 'private',
  authKind: 'deploy_key',
  installationId: null,
  deployKeyId: 'dk_' + 'a'.repeat(24),
  connectedBy: 'human:u1',
}

/** Shared behaviour for every ConnectedRepoStore (only the in-memory one runs here; the DB store is not exercised against Postgres yet). */
export function connectedRepoStoreBehavior(
  name: string,
  make: () => Promise<ConnectedRepoStore> | ConnectedRepoStore,
) {
  describe(name, () => {
    it('connect persists the repo with what a deploy needs; disconnect removes it', async () => {
      const store = await make()
      await store.add(publicRepo)
      await store.add({
        ...publicRepo,
        repoId: 7,
        fullName: 'kindred/app',
        visibility: 'private',
        authKind: 'github_app',
        installationId: 99,
      })
      expect(
        (await store.list()).map((r) => [r.fullName, r.branch, r.visibility, r.installationId]),
      ).toEqual([
        ['kindred/app', 'main', 'private', 99],
        ['kindred/site', 'main', 'public', null],
      ])

      const removed = await store.remove('Kindred/Site', 'main')
      expect(removed?.repoId).toBe(42)
      expect((await store.list()).map((r) => r.fullName)).toEqual(['kindred/app'])
    })

    it('the same repo can be connected on two branches, but not twice on one', async () => {
      const store = await make()
      await store.add(publicRepo)
      await store.add({ ...publicRepo, branch: 'staging' })
      await expect(store.add(publicRepo)).rejects.toBeInstanceOf(RepoAlreadyConnectedError)
      expect(await store.list()).toHaveLength(2)
    })

    it('a private repo without an installation id is refused loudly', async () => {
      const store = await make()
      await expect(
        store.add({
          ...publicRepo,
          visibility: 'private',
          authKind: 'github_app',
          installationId: null,
        }),
      ).rejects.toThrow(/installation id/)
    })

    it('a deploy-key repo has no repo id, stores only the key id, and is unique by name + branch', async () => {
      const store = await make()
      await store.add(deployKeyRepo)
      await expect(
        store.add({ ...deployKeyRepo, fullName: 'Kindred/Secret' }),
      ).rejects.toBeInstanceOf(RepoAlreadyConnectedError)
      expect(await store.list()).toMatchObject([
        {
          fullName: 'kindred/secret',
          repoId: null,
          authKind: 'deploy_key',
          deployKeyId: deployKeyRepo.deployKeyId,
        },
      ])
      expect((await store.remove('kindred/secret', 'main'))?.deployKeyId).toBe(
        deployKeyRepo.deployKeyId,
      )
    })

    it('a deploy-key repo without a key id is refused loudly', async () => {
      await expect((await make()).add({ ...deployKeyRepo, deployKeyId: null })).rejects.toThrow(
        /key id/,
      )
    })

    it('disconnecting something not connected returns null', async () => {
      expect(await (await make()).remove('kindred/none', 'main')).toBeNull()
    })
  })
}

connectedRepoStoreBehavior('InMemoryConnectedRepoStore', () => new InMemoryConnectedRepoStore())
