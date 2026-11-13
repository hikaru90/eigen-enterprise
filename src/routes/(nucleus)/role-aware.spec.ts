import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canOpen, GUARDED_PAGES, pageCapability } from '$lib/access/capabilities'
import { capabilitiesFor } from '$lib/server/auth/capabilities'
import { MEMBER_ROLES, type MemberRole } from '$lib/server/auth/roles'
import { SubstrateUnavailableError } from '$lib/server/ee/client'
import { buildShellNav } from '$lib/shell/nav'
import { settingsSections } from '$lib/shell/settings-nav'

/**
 * Contribute `2bda4814`: a member must never be offered something that
 * answers 403. Two halves:
 *  1. every guarded page's real load refuses exactly the roles whose
 *     capability set says "no" (the set and the guards cannot drift);
 *  2. the nav and the settings tabs a role is shown hold only pages its set
 *     opens — so, by 1, none of them answers 403.
 */

const { roleMock } = vi.hoisted(() => ({ roleMock: vi.fn(async (_id: string): Promise<MemberRole | null> => 'member') }))
vi.mock('$lib/server/auth/user-role', async () => {
  const { isAdminRole } = await import('$lib/server/auth/roles')
  return { getUserRole: roleMock, isUserAdmin: async (id: string) => isAdminRole(await roleMock(id)) }
})
vi.mock('$lib/server/members', () => ({
  humanActor: async (id: string) => ({ id, role: await roleMock(id) }),
  memberDeps: async () => ({ companyName: 'Kindred' }),
  listMembers: async () => ({ members: [], invites: [] }),
  groupDeps: async () => ({}),
  listGroups: async () => [],
}))
vi.mock('$lib/server/overview/sources', () => ({ companyIdentity: async () => ({ name: 'Kindred', logo: null }) }))
vi.mock('$lib/server/website/owner-run', () => ({
  ownerRun: async () => ({ repositories: [], activity: [] }),
  logAppFailure: () => {},
  plainAppMessage: () => 'unavailable',
}))
// Settings → Modules reads the kernel (kernel.module_list, past its guard).
// Drive → GitHub reads its activation and the (empty) connected tokens past its guard.
vi.mock('../../../modules/repos/live', () => ({ reposService: () => ({ tokens: async () => [] }) }))
vi.mock('$lib/server/boot', () => ({
  appKernel: async () => ({
    activations: { get: async () => true },
    registry: {
      execute: async (name: string) => {
        if (name === 'kernel.module_list') return []
        throw new Error(`the guarded loads checked here only list modules, not ${name}`)
      },
    },
  }),
}))

import { load as brandEditor } from './brand/editor/[setId]/+page.server'
import { load as brandExtract } from './brand/extract/+page.server'
import { load as driveGithub } from './drive/github/+page.server'
import { load as website } from './m/website/+page.server'
import { load as approvals } from './settings/approvals/+page.server'
import { _backupsDeps, load as backups } from './settings/backups/+page.server'
import { load as company } from './settings/company/+page.server'
import { load as members } from './settings/members/+page.server'
import { load as modules } from './settings/modules/+page.server'

type Load = (event: never) => Promise<unknown>

/** The real load of every guarded page (GUARDED_PAGES), at a path below its prefix. */
const LOADS: Record<string, { path: string; load: Load }> = {
  '/settings/company': { path: '/settings/company', load: company as Load },
  '/settings/members': { path: '/settings/members', load: members as Load },
  '/settings/approvals': { path: '/settings/approvals', load: approvals as Load },
  '/settings/backups': { path: '/settings/backups', load: backups as Load },
  '/settings/modules': { path: '/settings/modules', load: modules as Load },
  '/m/website': { path: '/m/website', load: website as Load },
  '/brand/extract': { path: '/brand/extract', load: brandExtract as Load },
  // A malformed set id is the editor's own 404 — past the guard.
  '/brand/editor': { path: '/brand/editor/not-a-set', load: brandEditor as Load },
  '/drive/github': { path: '/drive/github', load: driveGithub as Load },
}

/** What a load does to this person: opens (a page or its own 404) or refuses (403 / sends away). */
async function outcome(load: Load, path: string): Promise<'opens' | 'refuses'> {
  const event = {
    locals: { user: { id: 'u1', email: 'u1@k.test' } },
    url: new URL(`http://x${path}`),
    params: { setId: 'not-a-set' },
    fetch: async () => new Response(JSON.stringify({ mode: 'ask' })),
  }
  try {
    await load(event as never)
    return 'opens'
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 404) return 'opens'
    if (status === 403 || status === 303) return 'refuses'
    throw err
  }
}

const manifests = ['messages', 'calls', 'website', 'email', 'brand', 'memory', 'drive', 'recap'].map((id) => ({
  id,
  name: id,
}))
const activations = new Map(manifests.map((m) => [m.id, true]))

describe('role-aware UI: the capability set and the route guards agree', () => {
  beforeEach(() => {
    _backupsDeps.client = () =>
      ({
        backups: async () => {
          throw new SubstrateUnavailableError('not on a box in this spec')
        },
      }) as never
  })

  it('every guarded page has its real load checked here', () => {
    expect(Object.keys(LOADS).sort()).toEqual(GUARDED_PAGES.map((p) => p.prefix).sort())
  })

  for (const role of MEMBER_ROLES) {
    for (const page of GUARDED_PAGES) {
      it(`${page.prefix}: a ${role} is refused exactly when the set says no`, async () => {
        roleMock.mockResolvedValue(role)
        const { path, load } = LOADS[page.prefix]
        const expected = capabilitiesFor(role)[page.capability] ? 'opens' : 'refuses'
        expect(await outcome(load, path)).toBe(expected)
      })
    }
  }
})

describe('role-aware UI: a member is never offered a page that refuses them', () => {
  const member = capabilitiesFor('member')

  it('the nav has no guarded page they lack, and keeps modules it does not know (Recap)', () => {
    const items = buildShellNav(manifests, activations, member).items
    for (const item of items) expect(canOpen(member, item.href)).toBe(true)
    expect(items.map((i) => i.id)).not.toContain('website')
    expect(items.map((i) => i.id)).toContain('recap')
  })

  it('the settings tabs hold only sections they can open', () => {
    const tabs = settingsSections(member)
    expect(tabs.map((t) => t.id)).toEqual(['account', 'llm', 'passkeys', 'api-keys'])
    for (const tab of tabs) expect(pageCapability(tab.href) === null || member[pageCapability(tab.href)!]).toBe(true)
  })

  it('what the owner sees and a member does not is exactly what refuses the member', async () => {
    const owner = capabilitiesFor('owner')
    const ownerHrefs = [...buildShellNav(manifests, activations, owner).items, ...settingsSections(owner)].map((i) => i.href)
    const memberHrefs = new Set(
      [...buildShellNav(manifests, activations, member).items, ...settingsSections(member)].map((i) => i.href as string),
    )
    const hidden = ownerHrefs.filter((h) => !memberHrefs.has(h))
    expect(hidden.sort()).toEqual([
      '/m/website',
      '/settings/approvals',
      '/settings/backups',
      '/settings/company',
      '/settings/members',
      '/settings/modules',
    ])
    roleMock.mockResolvedValue('member')
    for (const href of hidden) {
      const { path, load } = LOADS[href]
      expect(await outcome(load, path)).toBe('refuses')
    }
  })
})
