import { appKernel } from '$lib/server/boot'
import type { RequestHandler } from './$types'
import { randomUUID } from 'node:crypto'
import { error, json } from '@sveltejs/kit'
import { ensureSystemModulesActive } from '../../../../../modules/index'
import { defaultGitHubStore } from '../../../../../modules/website/github/store'
import { pushTarget, verifyGitHubSignature, type PushEvent } from './handler'

/**
 * GitHub App webhook. Signature-verified against the app's sealed webhook
 * secret; a push runs github.auto_deploy as the webhook's service principal —
 * which deploys ONLY apps whose owner switched auto-deploy on.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text()
  const store = defaultGitHubStore()
  if (!(await store.connection())) error(404, 'GitHub is not connected')
  const { webhookSecret } = await store.credentials()
  if (!verifyGitHubSignature(webhookSecret, body, request.headers.get('x-hub-signature-256'))) {
    error(401, 'invalid signature')
  }

  const event = request.headers.get('x-github-event')
  if (event === 'ping') return json({ ok: true })
  if (event !== 'push') return json({ ok: true, ignored: event })

  const target = pushTarget(JSON.parse(body) as PushEvent)
  if (!target) return json({ ok: true, ignored: 'not a branch push' })

  const kernel = await appKernel()
  await ensureSystemModulesActive(kernel)
  const ctx = () => ({
    principal: { id: 'github-webhook', kind: 'service' as const, roles: ['service'] },
    requestId: randomUUID(),
  })
  const { repoId, ...byName } = target
  // Legacy links (github.app_create) match by name; services match by GitHub's repo id + branch.
  const legacy = (await kernel.registry.execute('github.auto_deploy', byName, ctx())) as {
    deployed: unknown[]
  }
  const services =
    repoId === undefined
      ? { deployed: [] }
      : ((await kernel.registry.execute(
          'website.app_auto_deploy',
          { repoId, ...byName },
          ctx(),
        )) as { deployed: unknown[] })
  return json({ ok: true, deployed: [...legacy.deployed, ...services.deployed] })
}
