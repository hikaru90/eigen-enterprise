import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Phase-cohesion rule 7: every signed-in page renders inside the one shell
 * layout, i.e. lives in the `(nucleus)` route group. Only the pages below may
 * sit outside it — signed-out and public pages. Adding a page here needs a
 * reason in the comment next to it.
 */
const OUTSIDE_SHELL_ALLOWLIST = new Set([
  'login', // signed out: sign in
  'signup', // signed out: create the account
  'claim', // signed out: the installer's one-time owner claim
  'invite', // signed out: accept an invite
  's', // public company website index (while /s exists)
  's/[slug]', // public company website page
])

const routesDir = path.dirname(fileURLToPath(import.meta.url))
const SHELL_GROUP = '(nucleus)'

function pageRoutes(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) out.push(...pageRoutes(abs, rel ? `${rel}/${name}` : name))
    else if (name === '+page.svelte') out.push(rel)
  }
  return out
}

const routes = pageRoutes(routesDir)

describe('shell guard (phase-cohesion rule 7)', () => {
  it('finds the pages (the walk itself works)', () => {
    expect(routes).toContain(`${SHELL_GROUP}/settings`)
    expect(routes).toContain('login')
  })

  it('every page outside the shell group is on the signed-out/public allowlist', () => {
    const outside = routes.filter((r) => r.split('/')[0] !== SHELL_GROUP)
    expect(outside.filter((r) => !OUTSIDE_SHELL_ALLOWLIST.has(r))).toEqual([])
  })

  it('the allowlist names no page that is gone (keep it short and true)', () => {
    for (const r of OUTSIDE_SHELL_ALLOWLIST) expect(routes).toContain(r)
  })

  it('every shell page titles itself "<Page> · <Section> · eigenEnterprise" through docTitle', () => {
    const untitled = routes
      .filter((r) => r.split('/')[0] === SHELL_GROUP && !r.includes('[...missing'))
      .filter((r) => {
        const src = readFileSync(path.join(routesDir, r, '+page.svelte'), 'utf8')
        return !/<title>\{docTitle\(/.test(src)
      })
    expect(untitled).toEqual([])
  })
})
