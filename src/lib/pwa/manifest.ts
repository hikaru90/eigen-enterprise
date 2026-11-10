import type { IdentityColors, IdentityTokens } from './identity'

/**
 * The installable app (Web App Manifest): eigenEnterprise on a phone's home
 * screen or a desktop dock opens full-screen on Messages and wears the
 * company's identity (src/lib/pwa/identity.ts) — each instance installs as its
 * own app. Served by src/routes/manifest.webmanifest/+server.ts.
 */

export const PRODUCT_NAME = 'eigenEnterprise'

export type ManifestIcon = { src: string; sizes: string; type: 'image/png'; purpose: 'any' | 'maskable' }

export type WebAppManifest = {
  id: string
  name: string
  short_name: string
  description: string
  start_url: string
  scope: string
  display: 'standalone'
  background_color: string
  theme_color: string
  icons: ManifestIcon[]
}

const PRODUCT_ICONS: ManifestIcon[] = [
  { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
]

export function webAppManifest(t: IdentityTokens, colors: IdentityColors): WebAppManifest {
  const v = t.version
  const icons: ManifestIcon[] = t.initial
    ? [
        { src: `/app-icon/any-192.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/app-icon/any-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/app-icon/maskable-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
    : PRODUCT_ICONS
  return {
    id: '/',
    name: t.name,
    short_name: t.name,
    description: 'The website is your company.',
    start_url: '/messages',
    scope: '/',
    display: 'standalone',
    background_color: colors.background,
    theme_color: colors.background,
    icons,
  }
}
