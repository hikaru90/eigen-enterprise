import { describe, expect, it } from 'vitest'
import { workloadName } from './module-manifest'
import {
  deployModuleRequestSchema,
  dryRunAnswerSchema,
  MODULE_PROBLEM_TYPES,
  moduleAnswerSchema,
  moduleBundleHandoffName,
  moduleListAnswerSchema,
  moduleLogsQuerySchema,
  moduleProblemSchema,
  moduleSocketDir,
  moduleUnitUser,
  moduleViewSchema,
  moduleWorkload,
  removeModuleRequestSchema,
  startModuleRequestSchema,
  stopModuleRequestSchema,
  type ModuleView,
} from './module-workload'

const sha = 'ab'.repeat(32)
const commit = 'c0'.repeat(20)
const view: ModuleView = {
  id: 'hello',
  workload: 'mod-hello',
  version: '0.1.0',
  commit,
  bundleSha256: sha,
  desired: 'running',
  stopReason: null,
  state: 'running',
  error: null,
  restarts: 0,
  since: '2026-11-24T12:00:00.000Z',
  releases: [{ commit, bundleSha256: sha }],
}
const deploy = {
  id: 'hello',
  version: '0.1.0',
  commit,
  manifest: { manifest: 'eigen.module/1' },
  receipt: { v: 1 },
  tarball: `hello-${sha.slice(0, 12)}.tar.gz`,
  sha256: sha,
  token: 'ef'.repeat(32),
  author: 'user:u1',
}

describe('module workload contract', () => {
  it('names agree with module-manifest.ts', () => {
    expect(moduleWorkload('time-off')).toBe(workloadName('time-off'))
    expect(moduleUnitUser('hello')).toBe('ee-mod-hello')
    expect(moduleBundleHandoffName('hello', sha)).toBe(deploy.tarball)
    expect(moduleSocketDir('/var/lib/ee-state/os', 'hello')).toBe(
      '/var/lib/ee-state/os/modules/hello/run',
    )
    expect(() => moduleBundleHandoffName('../x', sha)).toThrow()
  })

  it('accepts a deploy and a dry run, refusing extras and a mismatched tarball name', () => {
    expect(deployModuleRequestSchema.parse(deploy)).toEqual(deploy)
    expect(deployModuleRequestSchema.parse({ ...deploy, dryRun: true }).dryRun).toBe(true)
    expect(deployModuleRequestSchema.safeParse({ ...deploy, extra: 1 }).success).toBe(false)
    expect(
      deployModuleRequestSchema.safeParse({ ...deploy, tarball: 'other-abababababab.tar.gz' })
        .success,
    ).toBe(false)
    expect(
      deployModuleRequestSchema.safeParse({ ...deploy, tarball: '../../etc/passwd' }).success,
    ).toBe(false)
  })

  it('round-trips the view and every answer', () => {
    expect(moduleViewSchema.parse(view)).toEqual(view)
    expect(moduleAnswerSchema.parse({ module: view })).toEqual({ module: view })
    expect(moduleListAnswerSchema.parse({ modules: [view] })).toEqual({ modules: [view] })
    expect(dryRunAnswerSchema.parse({ passed: false, log: 'test failed' })).toEqual({
      passed: false,
      log: 'test failed',
    })
    const failed = {
      ...view,
      state: 'failed',
      desired: 'stopped',
      stopReason: 'failed',
      error: 'Hello stopped answering.',
    }
    expect(moduleViewSchema.parse(failed)).toEqual(failed)
    expect(moduleViewSchema.safeParse({ ...view, state: 'crashed' }).success).toBe(false)
    expect(
      moduleViewSchema.safeParse({ ...view, releases: [...Array(4)].map(() => view.releases[0]) })
        .success,
    ).toBe(false)
  })

  it('accepts stop, start and remove bodies', () => {
    expect(
      stopModuleRequestSchema.parse({
        author: 'a',
        reason: 'person',
        sentence: 'Switched off by Ada.',
      }).reason,
    ).toBe('person')
    expect(
      stopModuleRequestSchema.safeParse({ author: 'a', reason: 'bored', sentence: 'x' }).success,
    ).toBe(false)
    expect(startModuleRequestSchema.parse({ author: 'a' })).toEqual({ author: 'a' })
    expect(removeModuleRequestSchema.safeParse({}).success).toBe(false)
  })

  it('defaults logs to 200 lines and caps them', () => {
    expect(moduleLogsQuerySchema.parse({})).toEqual({ lines: 200 })
    expect(moduleLogsQuerySchema.parse({ lines: '50' })).toEqual({ lines: 50 })
    expect(moduleLogsQuerySchema.safeParse({ lines: '0' }).success).toBe(false)
  })

  it('names the problem types', () => {
    expect(Object.values(MODULE_PROBLEM_TYPES)).toEqual([
      'urn:ee:receipt_invalid',
      'urn:ee:catalog_gap',
      'urn:ee:module_busy',
      'urn:ee:module_not_found',
      'urn:ee:secret_undeclared',
    ])
    expect(
      moduleProblemSchema.parse({
        type: 'urn:ee:catalog_gap',
        title: 'catalog gap',
        detail: 'x',
        missing: ['uses.tools:a.b'],
      }).missing,
    ).toEqual(['uses.tools:a.b'])
  })
})
