import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from './approvals'
import { InMemoryEventSink } from './events'
import { createOperationsTools, KERNEL_OPERATIONS_TOOL_NAMES, type OperationsCapability, type OperationsPort } from './operations-tools'
import { delegatedPrincipal } from './principals'
import { KernelRegistry } from './registry'

const owner: ToolContext = { principal: delegatedPrincipal({ id: 'u-owner', roles: ['admin', 'member'] }, 'orchestrator'), requestId: 'r1' }
const admin: ToolContext = { principal: { id: 'u-admin', kind: 'human', roles: ['admin', 'member'] }, requestId: 'r2' }
const bareAgent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'r3' }

function setup() {
  const calls: unknown[] = []
  const caps: Record<string, OperationsCapability[]> = {
    'u-owner': ['company.manage', 'backups.manage', 'owner'],
    'u-admin': ['company.manage', 'updates.manage'],
  }
  const port: OperationsPort = {
    can: async (userId, capability) => (caps[userId] ?? []).includes(capability),
    setLogo: async (userId, input) => {
      calls.push(['setLogo', userId, input.mime, Array.from(input.bytes), input.crop])
      return input.mime === 'image/png' && input.crop === undefined
        ? { ok: false, status: 400, error: 'Position the logo in the frame, then save.' }
        : { ok: true }
    },
    recropLogo: async (userId, crop) => {
      calls.push(['recropLogo', userId, crop])
      return { ok: true }
    },
    removeLogo: async (userId) => {
      calls.push(['removeLogo', userId])
    },
    runBackup: async (author) => {
      calls.push(['runBackup', author])
      return { runId: 'run-1' }
    },
    releaseStatus: async () => {
      calls.push(['releaseStatus'])
      return {
        installed: { release: 'eigenenterprise-0.5.35-0123456789ab', tarball: 'eigenenterprise-0.5.35-0123456789ab-linux-x64.tar.gz', version: '0.5.35' },
        managed: false,
        latest: { release: 'eigenenterprise-0.5.36-a12f40909743', version: '0.5.36', state: 'newer', notes: 'Fixes.' },
        latestError: null,
        job: null,
        lastOutcome: { release: 'eigenenterprise-0.5.35-0123456789ab', from: null, step: 'done', ok: true, reason: null, rolledBack: false },
        rollback: { to: null, refused: 'no earlier release is on this server to roll back to' },
      }
    },
    installRelease: async (release, author) => {
      calls.push(['installRelease', release, author])
      return { jobId: 'job-1', status: 'running' }
    },
    rollbackRelease: async (author, to) => {
      calls.push(['rollbackRelease', author, to])
      return { from: 'eigenenterprise-0.5.36-a12f40909743-linux-x64.tar.gz', to: 'eigenenterprise-0.5.35-0123456789ab-linux-x64.tar.gz' }
    },
  }
  const approvals = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), new InMemoryApprovalModeStore('allow_all')),
    approvalStore: approvals,
  })
  for (const tool of createOperationsTools({ port })) registry.register(tool)
  /** Runs once behind the owner's approval (every one of these always asks). */
  const approved = async (name: string, input: unknown, ctx: ToolContext) => {
    const gated = await registry.execute(name, input, ctx).catch((e) => e)
    expect(gated).toMatchObject({ code: 'approval_required' })
    await approvals.decide(gated.details.approvalId, 'approved', 'u-owner')
    return registry.execute(name, input, ctx)
  }
  return { registry, calls, approved }
}

describe('company operations tools', () => {
  it('are the logo, backup-now and release-install tools, each always behind the owner’s approval', () => {
    const { registry } = setup()
    for (const name of KERNEL_OPERATIONS_TOOL_NAMES.filter((n) => n !== 'kernel.release_status')) {
      expect(registry.get(name)).toMatchObject({ auditClass: 'mutate', approvalAlways: true })
    }
  })

  it('uploads a logo from base64 with its crop, as the person, after approval', async () => {
    const { calls, approved } = setup()
    const crop = { left: 0, top: 0, size: 10 }
    const out = await approved('settings.logo_set', { image_base64: 'AQID', mime: 'image/webp', crop }, admin)
    expect(out).toEqual({ ok: true })
    expect(calls).toEqual([['setLogo', 'u-admin', 'image/webp', [1, 2, 3], crop]])
  })

  it('a refused logo is invalid input with the page’s sentence', async () => {
    const { approved } = setup()
    await expect(approved('settings.logo_set', { image_base64: 'AQID', mime: 'image/png' }, admin)).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Position the logo in the frame, then save.',
    })
  })

  it('re-crops and removes the logo', async () => {
    const { calls, approved } = setup()
    await approved('settings.logo_recrop', { crop: { left: 1, top: 2, size: 3 } }, owner)
    await approved('settings.logo_remove', {}, owner)
    expect(calls).toEqual([
      ['recropLogo', 'u-owner', { left: 1, top: 2, size: 3 }],
      ['removeLogo', 'u-owner'],
    ])
  })

  it('runs a backup and installs a release as the owner (author human:<id>)', async () => {
    const { calls, approved } = setup()
    expect(await approved('kernel.backup_run', {}, owner)).toEqual({ runId: 'run-1' })
    expect(await approved('kernel.release_install', { release: 'eigenenterprise-0.5.36-a12f40909743' }, owner)).toEqual({ jobId: 'job-1', status: 'running' })
    expect(calls).toEqual([
      ['runBackup', 'human:u-owner'],
      ['installRelease', 'eigenenterprise-0.5.36-a12f40909743', 'human:u-owner'],
    ])
  })

  it('never more than the person may: an admin cannot back up or update; no person, no call', async () => {
    const { calls, approved } = setup()
    await expect(approved('kernel.backup_run', {}, admin)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(approved('kernel.release_install', { release: 'eigenenterprise-0.5.36-a12f40909743' }, admin)).rejects.toMatchObject({
      code: 'permission_denied',
    })
    await expect(approved('settings.logo_remove', {}, bareAgent)).rejects.toMatchObject({ code: 'no_person' })
    expect(calls).toEqual([])
  })

  it('release_status reads Settings → Updates for the owner or an admin, with the exact release name to install', async () => {
    const { registry, calls } = setup()
    expect(registry.get('kernel.release_status')).toMatchObject({ auditClass: 'read' })
    const out = await registry.execute('kernel.release_status', {}, admin)
    expect(out).toMatchObject({ latest: { release: 'eigenenterprise-0.5.36-a12f40909743', state: 'newer' } })
    expect(calls).toEqual([['releaseStatus']])
    await expect(registry.execute('kernel.release_status', {}, bareAgent)).rejects.toMatchObject({ code: 'no_person' })
  })

  it('release_rollback puts the release before back, as the owner, behind the owner’s approval (destructive)', async () => {
    const { registry, calls, approved } = setup()
    expect(registry.get('kernel.release_rollback')).toMatchObject({ auditClass: 'mutate', approvalAlways: true, approvalRisk: 'destructive' })
    expect(await approved('kernel.release_rollback', {}, owner)).toEqual({
      from: 'eigenenterprise-0.5.36-a12f40909743-linux-x64.tar.gz',
      to: 'eigenenterprise-0.5.35-0123456789ab-linux-x64.tar.gz',
    })
    await approved('kernel.release_rollback', { to: 'eigenenterprise-0.5.34-0123456789ab' }, owner)
    expect(calls).toEqual([
      ['rollbackRelease', 'human:u-owner', undefined],
      ['rollbackRelease', 'human:u-owner', 'eigenenterprise-0.5.34-0123456789ab'],
    ])
  })

  it('release_rollback is the owner’s alone: an admin is refused, no person is refused, a bare version is invalid', async () => {
    const { registry, calls, approved } = setup()
    await expect(approved('kernel.release_rollback', {}, admin)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(approved('kernel.release_rollback', {}, bareAgent)).rejects.toMatchObject({ code: 'no_person' })
    const err = await registry.execute('kernel.release_rollback', { to: '0.5.34' }, owner).catch((e) => e)
    expect(err).toMatchObject({ code: 'invalid_input' })
    expect(calls).toEqual([])
  })

  it('release_status says how the last update ended and what a rollback would do', async () => {
    const { registry } = setup()
    expect(await registry.execute('kernel.release_status', {}, admin)).toMatchObject({
      lastOutcome: { ok: true, step: 'done' },
      rollback: { to: null, refused: 'no earlier release is on this server to roll back to' },
    })
  })

  it('release_install refuses a bare version before asking anyone: it needs the full release name', async () => {
    const { registry, calls } = setup()
    const err = await registry.execute('kernel.release_install', { release: '0.5.36' }, owner).catch((e) => e)
    expect(err).toMatchObject({ code: 'invalid_input' })
    expect(String(err.message)).toContain('kernel.release_status')
    expect(calls).toEqual([])
  })
})
