import type { RequestHandler } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { identityColors, parseIconVariant } from '$lib/pwa/identity'
import { renderAppIcon } from '$lib/server/pwa/icon'
import { loadIdentityTokens } from '$lib/server/pwa/identity'

/**
 * The company's app icons (manifest, apple-touch-icon, favicon, notification
 * icon): its monogram on its brand color, rendered once per identity version.
 * Public, like the manifest. An unnamed company has the product's static icons.
 */

const PRODUCT: Record<string, string> = {
  'any-192.png': '/pwa-192.png',
  'any-512.png': '/pwa-512.png',
  'maskable-512.png': '/pwa-512-maskable.png',
  'apple-180.png': '/apple-touch-icon.png',
  'favicon-32.png': '/favicon.png',
}

const rendered = new Map<string, Buffer>()

export const GET: RequestHandler = async ({ params, url }) => {
  const variant = parseIconVariant(params.variant)
  if (!variant) error(404, 'no such icon')
  const tokens = await loadIdentityTokens()
  if (!tokens.initial) redirect(307, PRODUCT[params.variant])

  const key = `${tokens.version}:${params.variant}`
  let png = rendered.get(key)
  if (!png) {
    png = await renderAppIcon({ initial: tokens.initial, colors: identityColors(tokens), ...variant })
    if (rendered.size > 50) rendered.clear()
    rendered.set(key, png)
  }
  // Versioned URLs never change; unversioned ones (the notification icon) are revalidated.
  const current = url.searchParams.get('v') === tokens.version
  return new Response(new Uint8Array(png), {
    headers: {
      'content-type': 'image/png',
      'cache-control': current ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  })
}
