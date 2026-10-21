import type { GitHubConnectStatus } from '../../../../../../modules/website/github/connect-tools'
import type { PageServerLoad } from './$types'
import { randomBytes } from 'node:crypto'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { ownerRun } from '$lib/server/website/owner-run'
import { GITHUB_STATE_COOKIE, githubAppManifest } from '../../../../settings/hosting/manifest'

/**
 * /m/website/github: the GitHub App connection, nothing else (decision D-W4).
 * Repos are connected when you add an app (/m/website/apps/new) — public ones
 * by link, private ones with a read-only deploy key. This page only carries the
 * App itself: create it from a manifest, install it, see that it is installed.
 * The read runs through the kernel registry as the signed-in owner. The
 * manifest and state cookie are exactly what the callback endpoints under
 * /settings/hosting/github (hard-wired in the manifest) expect, so their shape
 * and cookie path stay verbatim.
 */
export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const listed = await ownerRun<{ github: GitHubConnectStatus }>(
    user,
    'website.github_list_repos',
    {},
  )

  let manifest: { json: string; state: string } | null = null
  if (!listed.github.connected) {
    const state = randomBytes(16).toString('hex')
    event.cookies.set(GITHUB_STATE_COOKIE, state, {
      path: '/settings/hosting/github',
      httpOnly: true,
      sameSite: 'lax',
      secure: event.url.protocol === 'https:',
      maxAge: 60 * 30,
    })
    manifest = {
      json: JSON.stringify(githubAppManifest(event.url.origin, randomBytes(2).toString('hex'))),
      state,
    }
  }

  return { github: listed.github, manifest }
}
