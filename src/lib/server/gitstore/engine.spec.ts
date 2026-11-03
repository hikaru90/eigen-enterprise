import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GitConflictError,
  GitEngine,
  resolveCompanyDataDir,
  type GitRunner,
  spawnGit,
} from './engine'
import { git, tempDir } from './test-helpers'

const ANA = { name: 'Ana Owner', email: 'ana@acme.test' }
const BEN = { name: 'Ben Admin', email: 'ben@acme.test' }

async function engine(opts: { debounceMs?: Record<string, number>; run?: GitRunner } = {}) {
  const e = new GitEngine({ dir: tempDir('engine'), ...opts })
  await e.open()
  return e
}

function bareRemote(): string {
  const dir = tempDir('remote')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir])
  return dir
}

describe('company data dir', () => {
  it('COMPANY_DATA_DIR, else $EE_STATE_DIR/company-data, else fail loud', () => {
    expect(resolveCompanyDataDir({ COMPANY_DATA_DIR: '/x' })).toBe('/x')
    expect(resolveCompanyDataDir({ EE_STATE_DIR: '/state' })).toBe('/state/company-data')
    expect(() => resolveCompanyDataDir({})).toThrow(/Refusing to guess/)
  })
})

describe('git engine', () => {
  it('commits with the acting member as author and the server as committer', async () => {
    const e = await engine()
    const { committed } = await e.stage('groups', [{ path: 'groups/a.yaml', content: 'a: 1\n' }], {
      author: ANA,
      message: 'groups: create A',
    })
    const hash = await committed
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    expect(git(e.dir, 'log', '-1', '--format=%an <%ae>|%cn|%s')).toBe(
      'Ana Owner <ana@acme.test>|eigenEnterprise|groups: create A',
    )
    // an unchanged rewrite is no commit
    expect(
      await (
        await e.stage('groups', [{ path: 'groups/a.yaml', content: 'a: 1\n' }], {
          author: ANA,
          message: 'same',
        })
      ).committed,
    ).toBeNull()
  })

  it('batches per surface within the debounce window; a different author splits the batch; other surfaces are untouched', async () => {
    const e = await engine({ debounceMs: { messages: 60_000 } })
    const p1 = (
      await e.stage('messages', [{ path: 'messages/g/2026-11-03.jsonl', content: '{"n":1}\n' }], {
        author: ANA,
        message: 'm1',
      })
    ).committed
    const p2 = (
      await e.stage(
        'messages',
        [{ path: 'messages/g/2026-11-03.jsonl', content: '{"n":1}\n{"n":2}\n' }],
        { author: ANA, message: 'm2' },
      )
    ).committed
    await (
      await e.stage('groups', [{ path: 'groups/x.yaml', content: 'x: 1\n' }], {
        author: BEN,
        message: 'g',
      })
    ).committed
    // groups committed alone; the message batch is still pending
    expect(git(e.dir, 'show', '--name-only', '--format=', 'HEAD')).toBe('groups/x.yaml')
    const p3 = (
      await e.stage(
        'messages',
        [{ path: 'messages/g/2026-11-03.jsonl', content: '{"n":1}\n{"n":2}\n{"n":3}\n' }],
        { author: BEN, message: 'm3' },
      )
    ).committed
    const [c1, c2] = await Promise.all([p1, p2])
    expect(c1).toBe(c2) // one commit for Ana's two writes
    expect(git(e.dir, 'log', '-1', '--format=%an|%s', c1!)).toBe('Ana Owner|messages: 2 changes')
    await e.flush()
    const c3 = await p3
    expect(git(e.dir, 'log', '-1', '--format=%an', c3!)).toBe('Ben Admin')
    expect(git(e.dir, 'rev-list', '--count', 'HEAD')).toBe('4')
    await e.close()
  })

  it('deletes are committed; changedSince reports A/M/D', async () => {
    const e = await engine()
    const base = await e.head()
    await (
      await e.stage(
        'g',
        [
          { path: 'groups/a.yaml', content: '1\n' },
          { path: 'groups/b.yaml', content: '1\n' },
        ],
        { author: ANA, message: 'add' },
      )
    ).committed
    const mid = await e.head()
    await (
      await e.stage(
        'g',
        [
          { path: 'groups/a.yaml', content: null },
          { path: 'groups/b.yaml', content: '2\n' },
        ],
        { author: ANA, message: 'change' },
      )
    ).committed
    expect(await e.changedSince(mid)).toEqual([
      { status: 'D', path: 'groups/a.yaml' },
      { status: 'M', path: 'groups/b.yaml' },
    ])
    expect(await e.changedSince(base, ['groups/'])).toEqual([
      { status: 'A', path: 'groups/b.yaml' },
    ])
    expect((await e.changedSince(null)).map((c) => c.path)).toEqual([
      '.gitattributes',
      'groups/b.yaml',
    ])
  })

  it('crash repair: files written but never committed are committed at boot', async () => {
    const e = await engine()
    writeFileSync(join(e.dir, 'stray.yaml'), 'x: 1\n')
    const fresh = new GitEngine({ dir: e.dir })
    await fresh.open()
    const c = await fresh.recoverUncommitted()
    expect(c).toMatch(/^[0-9a-f]{40}$/)
    expect(git(e.dir, 'status', '--porcelain')).toBe('')
    expect(await fresh.recoverUncommitted()).toBeNull()
  })

  it('push/pull: fast-forward pulls report what changed; credentials go through env, never argv', async () => {
    const remote = bareRemote()
    const a = await engine()
    await (
      await a.stage('g', [{ path: 'groups/a.yaml', content: '1\n' }], { author: ANA, message: 'a' })
    ).committed
    await a.push({ url: remote })

    const b = new GitEngine({ dir: tempDir('b') })
    execFileSync('git', ['clone', '-q', remote, b.dir])
    await b.open()
    await (
      await b.stage('g', [{ path: 'groups/b.yaml', content: '1\n' }], { author: BEN, message: 'b' })
    ).committed
    await b.push({ url: remote })

    const seen: Array<{ args: readonly string[]; env?: Record<string, string> }> = []
    const spy: GitRunner = (args, opts) => {
      seen.push({ args, env: opts.env })
      return spawnGit(args, opts)
    }
    const a2 = new GitEngine({ dir: a.dir, run: spy })
    const pulled = await a2.pull({
      url: remote,
      credentials: async () => ({ username: 'x-access-token', password: 'ghs_secret' }),
    })
    expect(pulled.changed).toEqual([{ status: 'A', path: 'groups/b.yaml' }])
    const fetch = seen.find((s) => s.args[0] === 'fetch')!
    expect(fetch.args.join(' ')).not.toContain('ghs_secret')
    expect(fetch.env?.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`,
    )
    // nothing new → nothing changed
    expect((await a2.pull({ url: remote })).changed).toEqual([])
  })

  it('diverged histories: pull and push fail loud, persist the conflict, overwrite nothing; clear only after a merge', async () => {
    const remote = bareRemote()
    const a = await engine()
    await a.push({ url: remote })
    const other = tempDir('other')
    execFileSync('git', ['clone', '-q', remote, other])
    writeFileSync(join(other, 'theirs.md'), 'theirs\n')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'edited on GitHub')
    git(other, 'push', '-q', 'origin', 'HEAD:main')

    await (
      await a.stage('g', [{ path: 'ours.md', content: 'ours\n' }], { author: ANA, message: 'ours' })
    ).committed
    const ours = await a.head()
    await expect(a.push({ url: remote })).rejects.toBeInstanceOf(GitConflictError)
    expect((await a.conflict())?.local).toBe(ours)
    await expect(a.pull({ url: remote })).rejects.toThrow(/diverged/)
    expect(await a.head()).toBe(ours)
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('edited on GitHub')
    await expect(a.clearConflict()).rejects.toThrow(/merge it first/)

    // a person merges by hand, then clears
    git(a.dir, 'fetch', '-q', remote, 'main')
    git(a.dir, 'merge', '-q', '--no-edit', 'FETCH_HEAD')
    await a.clearConflict()
    expect(await a.conflict()).toBeNull()
    await a.push({ url: remote })
  })
})
