import type { ParamMatcher } from '@sveltejs/kit'

/**
 * Matches any path that is not an API or internal path: the shell's
 * catch-all 404 must never answer for /api/* (machine clients keep their
 * plain 404s).
 */
export const match: ParamMatcher = (param) => !/^(api|_app)(\/|$)/.test(param)
