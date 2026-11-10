/**
 * The installable app (Web App Manifest): eigenEnterprise on a phone's home
 * screen or a desktop dock opens full-screen on Messages, named after the
 * company. Served by src/routes/manifest.webmanifest/+server.ts.
 */

export const PRODUCT_NAME = 'eigenEnterprise'

/** The app's light background (app.html theme-color). */
const BACKGROUND = '#e8ede5'

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

/** `companyName` is null until the owner names the company in the founding journey. */
export function webAppManifest(companyName: string | null): WebAppManifest {
  const name = companyName ?? PRODUCT_NAME
  return {
    id: '/',
    name,
    short_name: name,
    description: 'The website is your company.',
    start_url: '/messages',
    scope: '/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    icons: [
      { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
