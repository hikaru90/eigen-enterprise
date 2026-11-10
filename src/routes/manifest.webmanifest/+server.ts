import type { RequestHandler } from './$types'
import { webAppManifest } from '$lib/pwa/manifest'
import { foundingCompanyName } from '$lib/server/overview/sources'

/**
 * The Web App Manifest (src/lib/pwa/manifest.ts): public, like the company
 * website — browsers fetch it before anyone signs in, to offer "Install" /
 * "Add to Home Screen".
 */
export const GET: RequestHandler = async () => {
  const manifest = webAppManifest(await foundingCompanyName())
  return new Response(JSON.stringify(manifest), {
    headers: {
      'content-type': 'application/manifest+json',
      'cache-control': 'no-cache',
    },
  })
}
