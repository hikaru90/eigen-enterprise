import type { ConnectedRepo } from '../github/repos-store'

/**
 * How ee's mirror reads a connected repo (ee/src/sources.ts):
 * - public: https, no credentials;
 * - deploy_key: ssh with the key ee holds (only its id crosses the socket);
 * - github_app: https with an installation token minted just now, used for
 *   that one fetch and never stored.
 */

export type FetchInput = {
  name: string
  url: string
  ref: string
  token?: string
  deployKeyId?: string
}

/** One mirror per app, derived from its name. */
export const mirrorName = (app: string) => `gh-${app}`

export async function fetchInputFor(
  repo: Pick<
    ConnectedRepo,
    'fullName' | 'branch' | 'cloneUrl' | 'authKind' | 'installationId' | 'deployKeyId'
  >,
  app: string,
  mintToken: (installationId: number) => Promise<string>,
): Promise<FetchInput> {
  const base = { name: mirrorName(app), ref: repo.branch }
  if (repo.authKind === 'public') return { ...base, url: repo.cloneUrl }
  if (repo.authKind === 'deploy_key') {
    if (!repo.deployKeyId) throw new Error(`${repo.fullName} is a deploy-key repo without a key id`)
    return { ...base, url: `git@github.com:${repo.fullName}.git`, deployKeyId: repo.deployKeyId }
  }
  if (repo.installationId === null)
    throw new Error(`${repo.fullName} is an App repo without an installation id`)
  return { ...base, url: repo.cloneUrl, token: await mintToken(repo.installationId) }
}
