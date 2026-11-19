import type { RequestHandler } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { hasCompanyIcons, identityColors, parseIconVariant } from '$lib/pwa/identity'
import { companyStorage } from '$lib/server/company/live'
import { readCompanyLogo } from '$lib/server/company/service'
import { renderAppIcon, renderLogoIcon } from '$lib/server/pwa/icon'
import { loadIdentityTokens } from '$lib/server/pwa/identity'

/**
 * The company's app icons (manifest, apple-touch-icon, favicon, notification
 * icon): its logo (Settings → Company) when it has one, else its monogram on
 * its brand color, rendered once per identity version. Public, like the
 * manifest — the logo is what the company shows the world. Only rendered PNGs
 * leave here, never the uploaded file. A company with neither logo nor name
 * has the product's static icons.
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
  if (!hasCompanyIcons(tokens)) redirect(307, PRODUCT[params.variant])

  const key = `${tokens.version}:${params.variant}`
  let png = rendered.get(key)
  if (!png) {
    const colors = identityColors(tokens)
    if (tokens.logo) {
      const logo = await readCompanyLogo(tokens.logo, companyStorage())
      if (!logo) throw new Error(`[pwa] company logo ${tokens.logo} is the identity's logo but is not the current one`)
      png = await renderLogoIcon({ logo: logo.bytes, colors, ...variant })
    } else if (tokens.initial) {
      png = await renderAppIcon({ initial: tokens.initial, colors, ...variant })
    } else {
      throw new Error('[pwa] company icons without a logo or a name')
    }
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
