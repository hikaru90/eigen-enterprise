import { describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import {
  configureDemoGuestAccess,
  DEFAULT_DEMO_AI_CALLS_PER_IP,
  DEFAULT_DEMO_GUEST_EMAIL,
  hashClientIp,
  memoryDemoGuestStore,
  readDemoGuestAccess,
  resolveActiveDemoGuest,
  type DemoGuestDeps,
  type DemoGuestUserRecord,
} from './guest-access'

const USERS: DemoGuestUserRecord[] = [
  { id: 'u-owner', email: 'founder@box.test', name: 'Alex Owner', role: 'owner', kind: 'human' },
  { id: 'u-lena', email: 'lena.hoffmann@northwind-studio.example', name: 'Lena Hoffmann', role: 'admin', kind: 'human' },
  { id: 'u-sophie', email: DEFAULT_DEMO_GUEST_EMAIL, name: 'Sophie Wagner', role: 'member', kind: 'human' },
  { id: 'u-jonas', email: 'jonas.becker@northwind-studio.example', name: 'Jonas Becker', role: 'member', kind: 'human' },
  { id: 'u-bot', email: 'nova@coworker.local', name: 'Nova', role: 'member', kind: 'coworker' },
]

function makeDeps(opts: { demoActive?: boolean; users?: DemoGuestUserRecord[] } = {}) {
  const store = memoryDemoGuestStore()
  const users = opts.users ?? USERS
  const audit = vi.fn(async () => {})
  const deps: DemoGuestDeps = {
    store,
    demoModuleActive: async () => opts.demoActive ?? true,
    findUserById: async (id) => users.find((u) => u.id === id) ?? null,
    findUserByEmail: async (email) => users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null,
    audit,
  }
  return { store, deps, audit }
}

describe('demo guest access domain', () => {
  it('defaults to off with 2 AI calls per IP', async () => {
    const { deps } = makeDeps()
    expect(await resolveActiveDemoGuest(deps)).toBeNull()
    expect(await readDemoGuestAccess({ id: 'u-owner', role: 'owner' }, deps)).toEqual({
      enabled: false,
      guest_user_id: null,
      guest_email: null,
      guest_name: null,
      ai_calls_per_ip: DEFAULT_DEMO_AI_CALLS_PER_IP,
    })
  })

  it('owner can enable guest access using default Sophie teammate and default 2 AI calls/IP', async () => {
    const { deps, store, audit } = makeDeps()
    const out = await configureDemoGuestAccess({ id: 'u-owner', role: 'owner' }, { enabled: true }, deps)
    expect(out).toEqual({
      enabled: true,
      guest_user_id: 'u-sophie',
      guest_email: DEFAULT_DEMO_GUEST_EMAIL,
      guest_name: 'Sophie Wagner',
      ai_calls_per_ip: 2,
    })
    expect(store.updatedBy).toBe('u-owner')
    expect(audit).toHaveBeenCalledWith({
      type: 'demo.guest_access_changed',
      principalId: 'u-owner',
      payload: { enabled: true, was: false, guestUserId: 'u-sophie', aiCallsPerIp: 2 },
    })
    expect(await resolveActiveDemoGuest(deps)).toEqual({
      userId: 'u-sophie',
      email: DEFAULT_DEMO_GUEST_EMAIL,
      name: 'Sophie Wagner',
      aiCallsPerIp: 2,
    })
  })

  it('refuses non-owners on write, and non-admins on read', async () => {
    const { deps } = makeDeps()
    await expect(
      configureDemoGuestAccess({ id: 'u-lena', role: 'admin' }, { enabled: true }, deps),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(
      configureDemoGuestAccess({ id: 'u-sophie', role: 'member' }, { enabled: true }, deps),
    ).rejects.toBeInstanceOf(KernelError)
    await expect(readDemoGuestAccess({ id: 'u-sophie', role: 'member' }, deps)).rejects.toMatchObject({
      code: 'permission_denied',
    })
    // Admin may read
    expect((await readDemoGuestAccess({ id: 'u-lena', role: 'admin' }, deps)).enabled).toBe(false)
  })

  it('refuses owner, admin, AI co-worker, or unknown accounts as the guest teammate', async () => {
    const { deps } = makeDeps()
    for (const email of ['founder@box.test', 'lena.hoffmann@northwind-studio.example', 'nova@coworker.local', 'nobody@northwind-studio.example']) {
      await expect(
        configureDemoGuestAccess({ id: 'u-owner', role: 'owner' }, { enabled: true, guest_email: email }, deps),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('allows choosing another member teammate and custom ai_calls_per_ip (including 0)', async () => {
    const { deps } = makeDeps()
    const out = await configureDemoGuestAccess(
      { id: 'u-owner', role: 'owner' },
      { enabled: true, guest_email: 'jonas.becker@northwind-studio.example', ai_calls_per_ip: 1 },
      deps,
    )
    expect(out).toMatchObject({ guest_user_id: 'u-jonas', guest_name: 'Jonas Becker', ai_calls_per_ip: 1 })

    const zero = await configureDemoGuestAccess(
      { id: 'u-owner', role: 'owner' },
      { enabled: true, ai_calls_per_ip: 0 },
      deps,
    )
    expect(zero).toMatchObject({ guest_user_id: 'u-jonas', ai_calls_per_ip: 0 })

    await expect(
      configureDemoGuestAccess({ id: 'u-owner', role: 'owner' }, { enabled: true, ai_calls_per_ip: -1 }, deps),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('resolveActiveDemoGuest returns null if demo module is inactive or if guest was promoted to admin', async () => {
    const users = USERS.map((u) => ({ ...u }))
    const { deps } = makeDeps({ demoActive: true, users })
    await configureDemoGuestAccess({ id: 'u-owner', role: 'owner' }, { enabled: true }, deps)
    expect(await resolveActiveDemoGuest(deps)).not.toBeNull()

    // Inactive demo module disables guest entry immediately
    expect(await resolveActiveDemoGuest({ ...deps, demoModuleActive: async () => false })).toBeNull()

    // Promoting Sophie to admin disables guest entry immediately (defense in depth)
    users.find((u) => u.id === 'u-sophie')!.role = 'admin'
    expect(await resolveActiveDemoGuest(deps)).toBeNull()
  })

  it('hashes client IPs deterministically without keeping raw addresses', () => {
    const a = hashClientIp(' 203.0.113.42 ')
    const b = hashClientIp('203.0.113.42')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toContain('203.0.113.42')
  })
})
