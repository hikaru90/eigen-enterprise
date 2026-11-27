import { describe, expect, it } from 'vitest'
import {
  emptyE2eMap,
  expandChanged,
  globalTrigger,
  mergeE2eMap,
  mergeUnitDeps,
  selectE2e,
  selectUnitExtras,
} from './core.mjs'

describe('globalTrigger', () => {
  it('re-runs everything when the toolchain, schema or messages change', () => {
    for (const p of ['package.json', 'package-lock.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'drizzle/0200_x.sql', 'drizzle/meta/_journal.json', 'messages/en.json', 'scripts/test-cache/core.mjs', 'svelte.config.js', 'tsconfig.json']) {
      expect(globalTrigger('unit', p), p).toBeTruthy()
      expect(globalTrigger('e2e', p), p).toBeTruthy()
    }
  })
  it('e2e also re-runs everything for its harness, mocks and static files', () => {
    for (const p of ['src/routes/e2e/test-helpers.ts', 'src/routes/e2e/fixtures/a.pdf', 'scripts/mock-gateway.mjs', 'scripts/e2e.sh', 'static/manifest.json', 'src/app.html']) {
      expect(globalTrigger('e2e', p), p).toBeTruthy()
      expect(globalTrigger('unit', p), p).toBeFalsy()
    }
  })
  it('ordinary source and e2e spec files are not global', () => {
    for (const p of ['modules/email/inbox/service.ts', 'src/routes/e2e/drive.e2e.ts', 'plan/progress.md']) {
      expect(globalTrigger('e2e', p), p).toBeFalsy()
      expect(globalTrigger('unit', p), p).toBeFalsy()
    }
  })
})

describe('selectUnitExtras (what the import graph cannot see)', () => {
  const deps = {
    'scripts/check-migrations.spec.ts': { reads: ['drizzle/meta/_journal.json'], dirs: [], spawnRepo: false, spawnTmp: false },
    'src/lib/kernel/ui-parity.spec.ts': { reads: ['src/routes/(nucleus)/m/email/+page.server.ts'], dirs: ['src/routes/(nucleus)/m/email'], recursiveDirs: ['src/routes'], spawnRepo: false, spawnTmp: false },
    'scripts/tag-gate.spec.ts': { reads: [], dirs: [], spawnRepo: false, spawnTmp: true },
    'scripts/assert-oss-no-secrets.spec.ts': { reads: [], dirs: [], spawnRepo: true, spawnTmp: false },
    'modules/a/a.spec.ts': { reads: [], dirs: [], spawnRepo: false, spawnTmp: false },
  }
  it('picks specs that read a changed file, list its directory, or run repo scripts', () => {
    expect([...selectUnitExtras({ changed: ['src/routes/(nucleus)/m/email/+page.server.ts'], deps })].sort()).toEqual([
      'scripts/assert-oss-no-secrets.spec.ts',
      'src/lib/kernel/ui-parity.spec.ts',
    ])
    // a new file in a directory a spec walks (recursively)
    expect(selectUnitExtras({ changed: ['src/routes/new/+page.svelte'], deps }).has('src/lib/kernel/ui-parity.spec.ts')).toBe(true)
    // a shell script a spec runs in a temp repo
    expect(selectUnitExtras({ changed: ['scripts/tag-gate.sh'], deps }).has('scripts/tag-gate.spec.ts')).toBe(true)
  })
  it('a spec that shells out inside the repo runs on any change', () => {
    expect([...selectUnitExtras({ changed: ['plan/progress.md'], deps })]).toEqual(['scripts/assert-oss-no-secrets.spec.ts'])
  })
})

describe('expandChanged', () => {
  const importers = {
    'modules/email/messages.ts': ['modules/email/index.ts'],
    'modules/email/index.ts': ['modules/email/service.ts', 'src/routes/x/+page.server.ts'],
    'modules/email/service.ts': ['modules/email/tools.ts'],
    'modules/email/tools.ts': ['src/lib/kernel/boot.ts'],
  }
  it('adds direct importers, and walks on only through files whose code never ran (barrels, constants)', () => {
    const inner = ['modules/email/service.ts', 'src/routes/x/+page.server.ts', 'modules/email/tools.ts']
    expect([...expandChanged(['modules/email/messages.ts'], importers, inner)].sort()).toEqual([
      'modules/email/index.ts',
      'modules/email/messages.ts',
      'modules/email/service.ts',
      'src/routes/x/+page.server.ts',
    ])
  })
})

describe('selectE2e', () => {
  const allE2e = ['src/routes/e2e/a.e2e.ts', 'src/routes/e2e/b.e2e.ts', 'src/routes/e2e/c.e2e.ts']
  const map = {
    ...emptyE2eMap(),
    tests: {
      'src/routes/e2e/a.e2e.ts': ['modules/email/service.ts', 'src/lib/kernel/registry.ts'],
      'src/routes/e2e/b.e2e.ts': ['modules/drive/service.ts', 'src/lib/kernel/registry.ts'],
    },
    startup: ['src/lib/kernel/boot.ts'],
    importers: { 'modules/email/consts.ts': ['modules/email/service.ts'] },
    inner: ['modules/email/service.ts', 'modules/drive/service.ts', 'src/lib/kernel/registry.ts', 'src/lib/kernel/boot.ts'],
  }
  it('runs only the files whose recorded code changed, plus files never recorded', () => {
    const r = selectE2e({ changed: ['modules/email/service.ts'], allE2e, map })
    expect(r.all).toBe(false)
    expect(r.files).toEqual(['src/routes/e2e/a.e2e.ts', 'src/routes/e2e/c.e2e.ts'])
  })
  it('a constant read by recorded code counts through its importer', () => {
    expect(selectE2e({ changed: ['modules/email/consts.ts'], allE2e, map }).files).toContain('src/routes/e2e/a.e2e.ts')
  })
  it('runs nothing recorded when no recorded code changed', () => {
    expect(selectE2e({ changed: ['plan/progress.md', 'src/cli/main.ts'], allE2e, map }).files).toEqual(['src/routes/e2e/c.e2e.ts'])
  })
  it('a changed e2e file runs itself', () => {
    expect(selectE2e({ changed: ['src/routes/e2e/b.e2e.ts'], allE2e, map }).files).toContain('src/routes/e2e/b.e2e.ts')
  })
  it('runs everything for code that ran at server start, a global trigger, or no map', () => {
    expect(selectE2e({ changed: ['src/lib/kernel/boot.ts'], allE2e, map }).all).toBe(true)
    expect(selectE2e({ changed: ['package-lock.json'], allE2e, map }).all).toBe(true)
    expect(selectE2e({ changed: ['modules/email/service.ts'], allE2e, map: null }).all).toBe(true)
  })
})

describe('merging after a green run', () => {
  it('e2e: files that ran get their new record, the rest keep theirs', () => {
    const old = { ...emptyE2eMap(), tests: { a: ['x'], b: ['y'] }, importers: { x: ['p'] }, inner: ['x', 'y'], startup: ['s'] }
    const next = mergeE2eMap(old, {
      tests: { a: ['z'] },
      startup: ['s2'],
      importers: { x: ['q'] },
      inner: ['z'],
      seen: ['x', 'z'],
    })
    expect(next.tests).toEqual({ a: ['z'], b: ['y'] })
    expect(next.startup).toEqual(['s2'])
    expect(next.importers).toEqual({ x: ['p', 'q'] })
    // x was seen and did not run inner code this time; y was not seen, keeps its old status
    expect(next.inner.sort()).toEqual(['y', 'z'])
  })
  it('unit: specs that ran replace their deps', () => {
    expect(mergeUnitDeps({ a: { reads: ['1'] }, b: { reads: ['2'] } }, { a: { reads: ['3'] } })).toEqual({ a: { reads: ['3'] }, b: { reads: ['2'] } })
  })
})
