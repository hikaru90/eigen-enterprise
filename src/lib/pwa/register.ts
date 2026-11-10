import { dev } from '$app/environment'

/**
 * Registers src/service-worker.ts (svelte.config.js keeps SvelteKit's own
 * registration off so it happens here, for signed-in people only). A failed
 * registration is logged loudly; the page keeps working without push.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register('/service-worker.js', { type: dev ? 'module' : 'classic' })
  } catch (err) {
    console.error('[pwa] service worker registration failed', err)
  }
}
