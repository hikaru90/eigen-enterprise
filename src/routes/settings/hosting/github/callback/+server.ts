import type { RequestHandler } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { GitHubApi } from '../../../../../../modules/github/api'
import { defaultGitHubStore } from '../../../../../../modules/github/store'
import { GITHUB_STATE_COOKIE } from '../../manifest'

/**
 * GitHub App manifest flow, step 2: GitHub redirects here with a one-time code.
 * Exchange it for the new app's credentials, seal them, then send the owner on
 * to install the app on their repositories.
 */
export const GET: RequestHandler = async (event) => {
  await requireAdmin(event.locals.user)
  const code = event.url.searchParams.get('code')
  const state = event.url.searchParams.get('state')
  const expected = event.cookies.get(GITHUB_STATE_COOKIE)
  if (!code) error(400, 'GitHub did not return a code')
  if (!state || !expected || state !== expected) error(400, 'GitHub state mismatch — start again from Settings → Hosting')
  event.cookies.delete(GITHUB_STATE_COOKIE, { path: '/settings/hosting/github' })

  const app = await new GitHubApi().convertManifest(code)
  await defaultGitHubStore().saveConnection(
    { appId: app.id, appSlug: app.slug, clientId: app.client_id, htmlUrl: app.html_url },
    { privateKeyPem: app.pem, webhookSecret: app.webhook_secret, clientSecret: app.client_secret },
  )
  throw redirect(303, `${app.html_url}/installations/new`)
}
