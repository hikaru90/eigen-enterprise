/**
 * Browser-mode stub for the SvelteKit `$app/paths` virtual module (no sveltekit()
 * plugin in vitest.browser.config.ts — components resolve paths identity-style).
 */
export const resolve = (path: string): string => path
export const resolveRoute = (path: string): string => path
export const asset = (path: string): string => path
export const base = ''
export const assets = ''
