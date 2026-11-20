import { driveViewSecret, mintViewToken, readViewToken, type ViewScope } from '$lib/server/drive'

/**
 * Rendered HTML in Drive: the page loads from /api/drive/view/<token>/<path>,
 * its relative links (styles, scripts, images) resolving inside the folder
 * the HTML file sits in. See modules/drive/view-token.ts.
 */
export const DRIVE_VIEW_PREFIX = '/api/drive/view/'

/** Where the file page's frame points: the token, then the file's own name. */
export function driveViewUrl(scope: ViewScope, now = Date.now()): string {
  return `${DRIVE_VIEW_PREFIX}${mintViewToken(driveViewSecret(), scope, now)}/${encodeURIComponent(scope.fileName)}`
}

/** The token's scope from a view path, or null (malformed, forged or expired). */
export function driveViewScope(token: string, now = Date.now()) {
  return readViewToken(driveViewSecret(), token, now)
}

/** Who a view path signs in as (the hook), or null. */
export function driveViewUser(pathname: string, now = Date.now()): string | null {
  const token = pathname.slice(DRIVE_VIEW_PREFIX.length).split('/')[0] ?? ''
  return driveViewScope(token, now)?.userId ?? null
}

/**
 * The headers a rendered page and its files go out with. The page runs
 * sandboxed (scripts yes; same origin, forms, popups and top navigation no),
 * loads its own files only from below its token, and may pull scripts,
 * styles, images and fonts from https (libraries on a CDN); it can't call
 * any other address with fetch/XHR, and only the Drive may frame it.
 */
export function driveViewHeaders(origin: string, token: string): Record<string, string> {
  const own = `${origin}${DRIVE_VIEW_PREFIX}${token}/`
  const csp = [
    'sandbox allow-scripts',
    `default-src ${own}`,
    `script-src ${own} 'unsafe-inline' 'unsafe-eval' https: blob:`,
    `style-src ${own} 'unsafe-inline' https:`,
    `img-src ${own} https: data: blob:`,
    `font-src ${own} https: data:`,
    `media-src ${own} https: data: blob:`,
    `connect-src ${own}`,
    "frame-src 'none'",
    "form-action 'none'",
    `base-uri ${own}`,
    "frame-ancestors 'self'",
  ].join('; ')
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
  }
}
