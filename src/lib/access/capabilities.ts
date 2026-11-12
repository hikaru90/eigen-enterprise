/**
 * What the signed-in person may open and do (Contribute `2bda4814`: never
 * offer something that answers 403). The server computes one capability set
 * per request from the same predicates the route guards call
 * (src/lib/server/auth/capabilities.ts) and hands it to the shell; every
 * menu, tab and card decides what to show from that set alone — no component
 * looks at a role. Pure and shared by server and browser.
 */

export const CAPABILITIES = [
  /** Settings → Company: the company name and logo. */
  'company.manage',
  /** Settings → Members & invites. */
  'members.manage',
  /** Settings → Approval mode. */
  'approvals.manage',
  /** Settings → Backups (the owner's alone, D11). */
  'backups.manage',
  /** Settings → Plugins: switching plugins on and off. */
  'modules.manage',
  /** The Website module's pages (/m/website/**). */
  'website.manage',
  /** Brand → Extract and the visual-set editor. */
  'brand.extract',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Every capability, true or false — never partial. */
export type Capabilities = Readonly<Record<Capability, boolean>>

/**
 * The pages a capability guards: their loads refuse (403, or a redirect away)
 * without it. A path not listed here is open to every signed-in member.
 */
export const GUARDED_PAGES: readonly { prefix: string; capability: Capability }[] = [
  { prefix: '/settings/company', capability: 'company.manage' },
  { prefix: '/settings/members', capability: 'members.manage' },
  { prefix: '/settings/approvals', capability: 'approvals.manage' },
  { prefix: '/settings/backups', capability: 'backups.manage' },
  { prefix: '/settings/modules', capability: 'modules.manage' },
  { prefix: '/m/website', capability: 'website.manage' },
  { prefix: '/brand/extract', capability: 'brand.extract' },
  { prefix: '/brand/editor', capability: 'brand.extract' },
]

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/** The capability a page needs, or null when every signed-in member may open it. */
export function pageCapability(path: string): Capability | null {
  let best: { capability: Capability; len: number } | null = null
  for (const page of GUARDED_PAGES) {
    if (under(path, page.prefix) && (!best || page.prefix.length > best.len)) {
      best = { capability: page.capability, len: page.prefix.length }
    }
  }
  return best?.capability ?? null
}

/** Whether a link to `path` may be offered to someone holding `caps`. */
export function canOpen(caps: Capabilities, path: string): boolean {
  const needed = pageCapability(path)
  return needed === null || caps[needed]
}
