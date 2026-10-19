import type { RequestHandler } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { GitHubApi } from '../../../../../../modules/github/api'
import { defaultGitHubStore } from '../../../../../../modules/github/store'

/**
 * GitHub App setup URL: after the owner installs the app, GitHub sends them here
 * with the installation id. Confirm with GitHub (using the app's own JWT) that
 * the installation belongs to THIS app before recording it.
 */
export const GET: RequestHandler = async (event) => {
  await requireAdmin(event.locals.user)
  const raw = event.url.searchParams.get('installation_id')
  const installationId = raw && /^\d{1,20}$/.test(raw) ? Number(raw) : null
  if (!installationId) error(400, 'GitHub did not return an installation id')

  const store = defaultGitHubStore()
  const conn = await store.connection()
  if (!conn) error(409, 'GitHub is not connected — start from Settings → Hosting')
  const creds = await store.credentials()
  await new GitHubApi().installation(conn.appId, creds.privateKeyPem, installationId)
  await store.setInstallation(installationId)
  throw redirect(303, '/settings/hosting')
}
