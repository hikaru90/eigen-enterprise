import { describe, expect, it } from 'vitest'
import type { Catalog, SourceTree } from '$lib/server/ee/client'
import {
  PRESENCE_ONLY_FILES,
  SUGGEST_TOTAL_BYTES,
  buildSuggestMessages,
  selectInputFiles,
  suggestContract,
  type SuggestChatFn,
} from './suggest'
import { FAKE_REV, FakeEe } from './testing'

const catalog: Catalog = {
  runtimes: { node: ['22'], static: [] },
  services: ['postgres'],
  capabilities: [],
}

const blob = (path: string, size = 100) => ({ path, type: 'blob' as const, size })

describe('selectInputFiles: a fixed, declared list of well-known names', () => {
  it('picks root manifests, readmes and framework configs in declared order; lockfiles are presence-only', () => {
    const entries: SourceTree['entries'] = [
      blob('index.js'),
      blob('package-lock.json', 400_000),
      blob('readme.md'),
      blob('package.json'),
      blob('svelte.config.js'),
      blob('Procfile'),
      blob('Dockerfile'),
      blob('src/package.json'),
      blob('requirements.txt'),
      { path: 'server', type: 'tree', size: null },
      blob('notes.txt'),
    ]
    const picked = selectInputFiles(entries)
    expect(picked).toEqual([
      'readme.md',
      'package.json',
      'Procfile',
      'requirements.txt',
      'svelte.config.js',
      'Dockerfile',
    ])
    expect(picked).not.toContain('package-lock.json')
    expect(PRESENCE_ONLY_FILES).toContain('package-lock.json')
    expect(picked).not.toContain('src/package.json')
    expect(picked).not.toContain('index.js')
  })

  it('skips files ee would refuse as too large', () => {
    expect(selectInputFiles([blob('README.md', 70_000), blob('package.json')])).toEqual([
      'package.json',
    ])
  })
})

describe('buildSuggestMessages', () => {
  it('carries the catalog ids, the contract semantics, the tree and the files, under the size cap', () => {
    const big = 'x'.repeat(SUGGEST_TOTAL_BYTES)
    const messages = buildSuggestMessages({
      catalog,
      tree: { entries: [blob('README.md'), blob('package.json')], truncated: false },
      files: [
        { path: 'README.md', size: big.length, content: big },
        { path: 'package.json', size: 2, content: '{}' },
      ],
    })
    const all = messages.map((m) => m.content).join('\n')
    expect(all).toContain('"node@22"')
    expect(all).toContain('"static"')
    expect(all).toMatch(/not through a shell/)
    expect(all).toMatch(/PORT/)
    expect(all).toContain('README.md')
    expect(all.length).toBeLessThan(SUGGEST_TOTAL_BYTES + 8000)
  })
})

function chatReturning(content: unknown): SuggestChatFn & { calls: unknown[] } {
  const calls: unknown[] = []
  const fn = (async (input: unknown) => {
    calls.push(input)
    return {
      choices: [
        { message: { content: typeof content === 'string' ? content : JSON.stringify(content) } },
      ],
    }
  }) as SuggestChatFn & { calls: unknown[] }
  fn.calls = calls
  return fn
}

function eeWithRepo(files: Record<string, string>) {
  const ee = new FakeEe()
  ee.tree = files
  return ee
}

const goodAnswer = {
  runtime: 'node@22',
  install: 'npm ci --omit=dev',
  build: null,
  start: 'node server/main.js',
  portEnv: null,
  healthPath: '/',
  staticDir: null,
  kind: 'web',
  confidence: 0.8,
  reasons: ['README says the server entry is server/main.js'],
  warnings: [],
}

describe('suggestContract: one gateway call, validated against the catalog', () => {
  it('reads the selected files from the mirror and returns form fields', async () => {
    const ee = eeWithRepo({ 'README.md': 'run node server/main.js', 'package.json': '{}' })
    const chat = chatReturning(goodAnswer)
    const out = await suggestContract(
      { ee, chat },
      { userId: 'u1', mirror: 'gh-shop', rev: FAKE_REV },
    )
    expect(out).toEqual({
      fields: {
        runtime: 'node@22',
        install: 'npm ci --omit=dev',
        build: '',
        start: 'node server/main.js',
        portEnv: '',
        health: '/',
        staticDir: '',
      },
      kind: 'web',
      confidence: 0.8,
      reasons: ['README says the server entry is server/main.js'],
      warnings: [],
      catalogGap: null,
      filesRead: ['README.md', 'package.json'],
    })
    expect(chat.calls).toHaveLength(1)
    expect(chat.calls[0]).toMatchObject({
      userId: 'u1',
      responseFormat: 'json_object',
      logContext: 'website_app_suggest',
    })
    const fileReads = ee.calls.filter((c) => c.verb === 'sourceFile').map((c) => c.input)
    expect(fileReads).toEqual([
      { name: 'gh-shop', rev: FAKE_REV, path: 'README.md' },
      { name: 'gh-shop', rev: FAKE_REV, path: 'package.json' },
    ])
  })

  it('a runtime outside the catalog is a catalog gap in plain words, never a substitution', async () => {
    const ee = eeWithRepo({ 'requirements.txt': 'flask' })
    const chat = chatReturning({
      ...goodAnswer,
      runtime: 'python@3.12',
      start: 'gunicorn app:app',
    })
    const out = await suggestContract(
      { ee, chat },
      { userId: 'u1', mirror: 'gh-shop', rev: FAKE_REV },
    )
    expect(out.fields.runtime).toBeNull()
    expect(out.catalogGap).toMatch(/python@3\.12/)
    expect(out.catalogGap).toMatch(/Node\.js 22/)
    expect(out.catalogGap).toMatch(/doesn't provide/)
  })

  it('shell syntax in a suggested command becomes a warning (ee runs argv)', async () => {
    const ee = eeWithRepo({ 'package.json': '{}' })
    const chat = chatReturning({ ...goodAnswer, build: 'npm run build && npm prune' })
    const out = await suggestContract(
      { ee, chat },
      { userId: 'u1', mirror: 'gh-shop', rev: FAKE_REV },
    )
    expect(out.fields.build).toBe('npm run build && npm prune')
    expect(out.warnings.join(' ')).toMatch(/not through a shell/)
  })

  it('an answer that does not match the schema fails loud with a plain message', async () => {
    const ee = eeWithRepo({ 'package.json': '{}' })
    for (const bad of ['not json', { ...goodAnswer, kind: 'database' }, { runtime: 'node@22' }]) {
      await expect(
        suggestContract(
          { ee, chat: chatReturning(bad) },
          { userId: 'u1', mirror: 'gh-shop', rev: FAKE_REV },
        ),
      ).rejects.toThrow(/couldn't read the repo well enough/)
    }
  })

  it('leaves the model room for a full answer (reasons and warnings run long)', async () => {
    const chat = chatReturning(goodAnswer)
    await suggestContract({ ee: eeWithRepo({ 'package.json': '{}' }), chat }, { userId: 'u1', mirror: 'gh-shop', rev: FAKE_REV })
    expect((chat.calls[0] as { maxTokens: number }).maxTokens).toBeGreaterThanOrEqual(4000)
  })

  it('an answer cut off at the length limit says so — not that the repo was unreadable', async () => {
    const cut: SuggestChatFn = async () => ({
      choices: [{ finish_reason: 'length', message: { content: '{"runtime":"node@22","reasons":["README says' } }],
    })
    await expect(
      suggestContract({ ee: eeWithRepo({ 'package.json': '{}' }), chat: cut }, { userId: 'u1', mirror: 'gh-shop', rev: FAKE_REV }),
    ).rejects.toThrow(/answer was cut off/)
  })
})
