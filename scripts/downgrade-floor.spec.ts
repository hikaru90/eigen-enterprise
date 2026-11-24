import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  downgradeFloor,
  drizzleChangeMovesFloor,
  MIN_DOWNGRADE_RELEASE,
} from './downgrade-floor.mjs'

const tags = ['0.5.19', '0.5.20', '0.5.21', '0.5.22', '0.5.23']

describe('downgradeFloor (the oldest release this one can be replaced with)', () => {
  it('goes back to the first release that installs exactly its target (ee 0.5.20) when nothing persistent changed', () => {
    expect(MIN_DOWNGRADE_RELEASE).toBe('0.5.20')
    expect(downgradeFloor({ version: '0.5.24', tags, changedSince: () => false })).toBe('0.5.20')
  })

  it('stops at a migration or an ee state change: older code must not run on what it cannot read', () => {
    // 0.5.22 → HEAD changed nothing; 0.5.21 → HEAD added a migration.
    const changed = new Set(['0.5.19', '0.5.20', '0.5.21'])
    expect(downgradeFloor({ version: '0.5.24', tags, changedSince: (t) => changed.has(t) })).toBe(
      '0.5.22',
    )
  })

  it('a change since the previous release means no downgrade: the floor is this release', () => {
    expect(downgradeFloor({ version: '0.5.24', tags, changedSince: () => true })).toBe('0.5.24')
  })

  it('ignores its own tag and newer ones, whatever order git lists them in', () => {
    expect(
      downgradeFloor({
        version: '0.5.22',
        tags: ['0.5.24', '0.5.22', '0.5.21', '0.5.23', '0.5.20'],
        changedSince: () => false,
      }),
    ).toBe('0.5.20')
  })
})

describe('drizzleChangeMovesFloor (which migration changes an older release cannot run on)', () => {
  const journal = (...tags: string[]) => ({
    entries: tags.map((tag, idx) => ({ idx: 178 + idx, tag, when: idx })),
  })
  const files: Record<string, string> = {
    'drizzle/0178_add.sql': 'ALTER TABLE a ADD COLUMN b text;',
    'drizzle/0179_drop.sql': '-- ee:contract\nALTER TABLE a DROP COLUMN old;',
    'drizzle/0177_coworker_event_routes.sql': 'CREATE TABLE x (id int);',
  }
  const input = (
    changes: Array<{ status: string; path: string }>,
    before = journal(),
    after = journal('0178_add'),
  ) => ({
    changes,
    readHead: (p: string) =>
      p === 'drizzle/meta/_journal.json' ? JSON.stringify(after) : files[p],
    readAt: (p: string) => {
      expect(p).toBe('drizzle/meta/_journal.json')
      return JSON.stringify(before)
    },
  })

  it('an added expand migration (and its appended journal entry) keeps the older release reachable', () => {
    expect(
      drizzleChangeMovesFloor(
        input([
          { status: 'M', path: 'drizzle/meta/_journal.json' },
          { status: 'A', path: 'drizzle/0178_add.sql' },
        ]),
      ),
    ).toBe(null)
  })

  it('an added -- ee:contract migration moves the floor', () => {
    expect(
      drizzleChangeMovesFloor(
        input([{ status: 'A', path: 'drizzle/0179_drop.sql' }], journal(), journal('0179_drop')),
      ),
    ).toMatch(/0179_drop is a `-- ee:contract` migration/)
  })

  it('an added migration from before the lint (baselined) moves the floor: it was never checked to only add', () => {
    expect(
      drizzleChangeMovesFloor(
        input([{ status: 'A', path: 'drizzle/0177_coworker_event_routes.sql' }]),
      ),
    ).toMatch(/0177_coworker_event_routes predates the expand\/contract lint/)
  })

  it('a changed or removed migration, or a journal that did more than append, moves the floor', () => {
    expect(drizzleChangeMovesFloor(input([{ status: 'M', path: 'drizzle/0178_add.sql' }]))).toMatch(
      /0178_add\.sql changed/,
    )
    expect(drizzleChangeMovesFloor(input([{ status: 'D', path: 'drizzle/0178_add.sql' }]))).toMatch(
      /changed \(D\)/,
    )
    expect(
      drizzleChangeMovesFloor(
        input(
          [{ status: 'M', path: 'drizzle/meta/_journal.json' }],
          journal('0178_add', '0179_x'),
          journal('0178_add'),
        ),
      ),
    ).toMatch(/journal changed other than by appending/)
  })
})

describe('node scripts/downgrade-floor.mjs <version> (in a git repository with release tags)', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'downgrade-floor.mjs')
  const repo = mkdtempSync(path.join(tmpdir(), 'ee-floor-'))
  afterAll(() => rmSync(repo, { recursive: true, force: true }))
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) delete env[k]
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=floor@spec',
        '-c',
        'user.name=floor',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        ...args,
      ],
      { cwd: repo, env, stdio: 'pipe' },
    )
  const entries: string[] = []
  const release = (version: string, migration?: { tag: string; sql: string }) => {
    if (migration) {
      writeFileSync(path.join(repo, 'drizzle', `${migration.tag}.sql`), migration.sql)
      entries.push(migration.tag)
    }
    writeFileSync(
      path.join(repo, 'drizzle/meta/_journal.json'),
      JSON.stringify({ entries: entries.map((tag, idx) => ({ idx, tag, when: idx })) }, null, 2),
    )
    writeFileSync(path.join(repo, 'VERSION'), version)
    git('add', '-A')
    git('commit', '-qm', version)
    git('tag', `v${version}`)
  }
  const floor = (version: string) =>
    execFileSync('node', [script, version], { cwd: repo, env, encoding: 'utf8' }).trim()

  it('the floor stays below expand migrations and becomes the first release containing a contract migration', () => {
    git('init', '-q')
    mkdirSync(path.join(repo, 'drizzle/meta'), { recursive: true })
    release('0.5.29')
    release('0.5.30', { tag: '0177_coworker_event_routes', sql: 'CREATE TABLE x (id int);' })
    release('0.5.31', { tag: '0178_add', sql: 'ALTER TABLE x ADD COLUMN y text;' })
    release('0.5.32', { tag: '0179_more', sql: 'CREATE TABLE z (id int);' })
    // Expand-only since 0.5.30; 0.5.30 added a baselined (unchecked) migration.
    expect(floor('0.5.33')).toBe('0.5.30')
    release('0.5.33', { tag: '0180_drop', sql: '-- ee:contract\nALTER TABLE x DROP COLUMN y;' })
    release('0.5.34', { tag: '0181_add', sql: 'ALTER TABLE z ADD COLUMN w text;' })
    expect(floor('0.5.35')).toBe('0.5.33')
  })
})
