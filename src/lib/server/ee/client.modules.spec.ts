import { describe, expect, it } from 'vitest'
import { moduleWorkload, type ModuleView } from '../../../../contracts/module-workload'
import { EeClient, SubstrateError, type EeTransport } from './client'

/** The kernel's ee client for module workloads (plan/phase-upgrades-u2.md §5). */

const C = 'c'.repeat(40)
const S = 'd'.repeat(64)
const view: ModuleView = {
  id: 'hello',
  workload: moduleWorkload('hello'),
  version: '0.1.0',
  commit: C,
  bundleSha256: S,
  desired: 'running',
  stopReason: null,
  state: 'running',
  error: null,
  restarts: 0,
  since: '2026-11-24T12:00:00.000Z',
  releases: [{ commit: C, bundleSha256: S }],
}
const deploy = {
  id: 'hello',
  version: '0.1.0',
  commit: C,
  manifest: { id: 'hello' },
  receipt: { v: 1 },
  tarball: `hello-${S.slice(0, 12)}.tar.gz`,
  sha256: S,
  token: 'e'.repeat(64),
  author: 'owner-1',
}

function recording(answer: (method: string, path: string, body: unknown) => { status: number; data: unknown }) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const transport: EeTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    return answer(method, path, body)
  }
  return { client: new EeClient(transport), calls }
}

describe('EeClient module verbs', () => {
  it('speaks the /v1/modules verbs with contract-checked bodies and answers', async () => {
    const { client, calls } = recording((method, path) => {
      if (path.endsWith('/logs?lines=50')) return { status: 200, data: { lines: ['a'] } }
      if (method === 'GET' && path === '/v1/modules') return { status: 200, data: { modules: [view] } }
      if (path === '/v1/modules' && method === 'POST') {
        return calls.at(-1)!.body && (calls.at(-1)!.body as { dryRun?: boolean }).dryRun
          ? { status: 200, data: { passed: true, log: 'ok' } }
          : { status: 202, data: { module: view } }
      }
      return { status: 200, data: { module: view } }
    })
    await expect(client.deployModule(deploy)).resolves.toEqual(view)
    await expect(client.dryRunModule(deploy)).resolves.toEqual({ passed: true, log: 'ok' })
    await expect(client.modules()).resolves.toEqual([view])
    await expect(client.module('hello')).resolves.toEqual(view)
    await client.stopModule('hello', { author: 'kernel', reason: 'failed', sentence: 'Hello is switched off.' })
    await client.startModule('hello', { author: 'kernel' })
    await expect(client.moduleLogs('hello', 50)).resolves.toEqual(['a'])
    await client.removeModule('hello', { author: 'owner-1' })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/modules',
      'POST /v1/modules',
      'GET /v1/modules',
      'GET /v1/modules/hello',
      'POST /v1/modules/hello/stop',
      'POST /v1/modules/hello/start',
      'GET /v1/modules/hello/logs?lines=50',
      'DELETE /v1/modules/hello',
    ])
    expect(calls[1]!.body).toMatchObject({ dryRun: true })
  })

  it('refuses a body the contract refuses before it leaves, and an answer it refuses when it arrives', async () => {
    const { client, calls } = recording(() => ({ status: 202, data: { module: { ...view, state: 'dancing' } } }))
    await expect(client.deployModule({ ...deploy, tarball: 'other-000000000000.tar.gz' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
    await expect(client.deployModule(deploy)).rejects.toThrow()
  })

  it('404 urn:ee:module_not_found is null; other problems keep their type', async () => {
    const { client } = recording((method, path) =>
      path === '/v1/modules/nope'
        ? { status: 404, data: { type: 'urn:ee:module_not_found', title: 'Not found', detail: 'no module nope' } }
        : { status: 422, data: { type: 'urn:ee:receipt_invalid', title: 'Receipt', detail: 'receipt key 1234 is not a trusted hub key' } },
    )
    await expect(client.module('nope')).resolves.toBeNull()
    const err = await client.deployModule(deploy).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubstrateError)
    expect(err).toMatchObject({ status: 422, type: 'urn:ee:receipt_invalid' })
  })
})
