import type { RequestHandler } from './$types'
import { identityColors } from '$lib/pwa/identity'
import { webAppManifest } from '$lib/pwa/manifest'
import { loadIdentityTokens } from '$lib/server/pwa/identity'

/**
 * The Web App Manifest (src/lib/pwa/manifest.ts) in this company's identity:
 * public, like the company website — browsers fetch it before anyone signs
 * in, to offer "Install" / "Add to Home Screen".
 */
export const GET: RequestHandler = async () => {
  const tokens = await loadIdentityTokens()
  return new Response(JSON.stringify(webAppManifest(tokens, identityColors(tokens))), {
    headers: {
      'content-type': 'application/manifest+json',
      'cache-control': 'no-cache',
    },
  })
}
