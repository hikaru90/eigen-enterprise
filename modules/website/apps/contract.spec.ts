import { describe, expect, it } from 'vitest'
import { AppUserError, CatalogGapUserError, contractFromForm, resolveContract } from './contract'

const catalog = { runtimes: { node: ['22'], static: [] }, services: ['postgres'], capabilities: [] }
const form = {
  runtime: 'node' as const,
  nodeVersion: '22',
  install: 'npm install --omit=dev',
  build: '',
  start: 'node index.js',
  health: '/',
}
const repoContract = {
  runtime: 'node',
  node: '22',
  build: [],
  start: ['node', 'server.js'],
  health: '/up',
}

describe('contractFromForm', () => {
  it('turns the form into an ee contract (argv, never a shell string)', () => {
    expect(contractFromForm(form)).toEqual({
      runtime: 'node',
      node: '22',
      build: [['npm', 'install', '--omit=dev']],
      start: ['node', 'index.js'],
      preStart: [],
      health: '/',
      services: [],
      capabilities: [],
    })
  })
  it('carries the port variable and a build step', () => {
    const c = contractFromForm({ ...form, build: 'npm run build', portEnv: 'APP_PORT' })
    expect(c.build).toEqual([
      ['npm', 'install', '--omit=dev'],
      ['npm', 'run', 'build'],
    ])
    expect(c.portEnv).toBe('APP_PORT')
  })
  it('refuses shell syntax in plain words', () => {
    expect(() => contractFromForm({ ...form, start: 'node index.js && rm -rf /' })).toThrow(
      AppUserError,
    )
    expect(() => contractFromForm({ ...form, start: 'node "a b.js"' })).toThrow(/quotes/)
  })
  it('a node app needs a start command', () => {
    expect(() => contractFromForm({ ...form, start: '' })).toThrow(/start command/)
  })
})

describe('resolveContract: ee.json vs the form', () => {
  it("the repo's ee.json wins; nothing is written to the company repo", () => {
    const r = resolveContract({
      repo: { present: true, contract: repoContract, gap: null, error: null },
      form,
      stored: null,
      catalog,
    })
    expect(r).toEqual({ source: 'repo', contract: repoContract })
  })
  it('no ee.json: the form becomes the contract (stored in the company repo by ee)', () => {
    const r = resolveContract({
      repo: { present: false, contract: null, gap: null, error: null },
      form,
      stored: null,
      catalog,
    })
    expect(r.source).toBe('form')
    expect(r.contract).toMatchObject({ start: ['node', 'index.js'] })
  })
  it('no ee.json and no form: a redeploy reuses the contract already in the company repo', () => {
    const stored = contractFromForm(form)
    const r = resolveContract({
      repo: { present: false, contract: null, gap: null, error: null },
      form: null,
      stored,
      catalog,
    })
    expect(r).toEqual({ source: 'form', contract: stored })
  })
  it('no ee.json, no form, nothing stored: ask for the form in plain words', () => {
    expect(() =>
      resolveContract({
        repo: { present: false, contract: null, gap: null, error: null },
        form: null,
        stored: null,
        catalog,
      }),
    ).toThrow(/no ee\.json.*how to build and start/i)
  })
  it('a runtime the catalog lacks is a catalog gap, in plain words, for the repo and for the form', () => {
    expect(() =>
      resolveContract({
        repo: {
          present: true,
          contract: { ...repoContract, node: '18' },
          gap: ['runtime node@18'],
          error: null,
        },
        form: null,
        stored: null,
        catalog,
      }),
    ).toThrow(CatalogGapUserError)
    try {
      resolveContract({
        repo: { present: false, contract: null, gap: null, error: null },
        form: { ...form, nodeVersion: '20' },
        stored: null,
        catalog,
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogGapUserError)
      expect((err as Error).message).toMatch(
        /Node\.js 20.*Node\.js 22.*change to Eigen.*not a container/,
      )
    }
  })
  it("an invalid ee.json is reported as the repo's problem", () => {
    expect(() =>
      resolveContract({
        repo: { present: true, contract: null, gap: null, error: 'ee.json is not valid JSON' },
        form,
        stored: null,
        catalog,
      }),
    ).toThrow(/ee\.json/)
  })
})
