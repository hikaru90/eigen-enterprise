import { describe, expect, it } from 'vitest'
import { COMMAND_ALLOWLIST, parseAllowlistedCommand } from './allowlist'

function parsed(command: string): { cmd: string; args: string[] } {
  return parseAllowlistedCommand(command)
}

describe('COMMAND_ALLOWLIST surface', () => {
  it('pins the exact allowlist entries (code + test)', () => {
    expect([...COMMAND_ALLOWLIST]).toEqual([
      'npm test',
      'npm run check',
      'npm run lint',
      'npm run db:migrate',
      'npx vitest run <args…>',
      'git add <paths…>',
      'git commit -m <message…>',
      'git status',
      'git diff',
      'git log',
      'mkdir <paths…>',
      'cp <paths…>',
      'mv <paths…>',
      'node scripts/<path> [args…]',
    ])
  })
})

describe('parseAllowlistedCommand — allowed forms', () => {
  it('passes exact entries through verbatim', () => {
    expect(parsed('npm test')).toEqual({ cmd: 'npm', args: ['test'], kind: 'exact' })
    expect(parsed('npm run check')).toEqual({ cmd: 'npm', args: ['run', 'check'], kind: 'exact' })
    expect(parsed('npm run lint')).toEqual({ cmd: 'npm', args: ['run', 'lint'], kind: 'exact' })
    expect(parsed('npm run db:migrate')).toEqual({ cmd: 'npm', args: ['run', 'db:migrate'], kind: 'exact' })
    expect(parsed('git status')).toEqual({ cmd: 'git', args: ['status'], kind: 'exact' })
    expect(parsed('git diff')).toEqual({ cmd: 'git', args: ['diff'], kind: 'exact' })
    expect(parsed('git log')).toEqual({ cmd: 'git', args: ['log'], kind: 'exact' })
  })

  it('tolerates surrounding whitespace on exact entries', () => {
    expect(parsed('  npm test  ')).toEqual({ cmd: 'npm', args: ['test'], kind: 'exact' })
  })

  it('npx vitest run: args are safe test paths/patterns', () => {
    expect(parsed('npx vitest run src/lib/kernel')).toEqual({
      cmd: 'npx',
      args: ['vitest', 'run', 'src/lib/kernel'],
      kind: 'vitest-args',
    })
    expect(parsed('npx vitest run modules/repo tools.spec.ts')).toEqual({
      cmd: 'npx',
      args: ['vitest', 'run', 'modules/repo', 'tools.spec.ts'],
      kind: 'vitest-args',
    })
    expect(parsed('npx vitest run --reporter=dot')).toEqual({
      cmd: 'npx',
      args: ['vitest', 'run', '--reporter=dot'],
      kind: 'vitest-args',
    })
  })

  it('git add: paths only', () => {
    expect(parsed('git add src/foo.ts modules/repo')).toEqual({
      cmd: 'git',
      args: ['add', 'src/foo.ts', 'modules/repo'],
      kind: 'git-paths',
    })
  })

  it('git commit: -m plus message tokens; message may carry the [type] convention', () => {
    expect(parsed('git commit -m [fix] add thing')).toEqual({
      cmd: 'git',
      args: ['commit', '-m', '[fix]', 'add', 'thing'],
      kind: 'commit-message',
    })
  })

  it('node: only scripts under scripts/', () => {
    expect(parsed('node scripts/migrate.mjs')).toEqual({
      cmd: 'node',
      args: ['scripts/migrate.mjs'],
      kind: 'node-script',
    })
    expect(parsed('node scripts/foo.mjs --flag=1 out.json')).toEqual({
      cmd: 'node',
      args: ['scripts/foo.mjs', '--flag=1', 'out.json'],
      kind: 'node-script',
    })
  })

  it('mkdir/cp/mv: safe relative paths, no flags', () => {
    expect(parsed('mkdir sub/dir')).toEqual({ cmd: 'mkdir', args: ['sub/dir'], kind: 'fs-paths' })
    expect(parsed('cp a.txt b.txt')).toEqual({ cmd: 'cp', args: ['a.txt', 'b.txt'], kind: 'fs-paths' })
    expect(parsed('mv old.ts new.ts')).toEqual({ cmd: 'mv', args: ['old.ts', 'new.ts'], kind: 'fs-paths' })
  })
})

describe('parseAllowlistedCommand — hostile inputs are rejected loud', () => {
  it('rejects shell metacharacters outright (no prefix heuristics to fool)', () => {
    for (const hostile of [
      '; rm -rf /',
      'npm test; rm -rf /',
      'npm test && rm -rf /',
      'npm test | cat',
      'npm test > /etc/passwd',
      'npm test < /etc/passwd',
      'echo `whoami`',
      'npm test $(rm -rf /)',
      'npm test\nrm -rf /',
      'npm test\rrm -rf /',
      "npm test 'quoted; cmd'",
      'npm test "quoted; cmd"',
      'npm test &',
      'git commit -m a(b)',
    ]) {
      expect(() => parsed(hostile), `expected rejection: ${hostile}`).toThrowError(
        /not in the repo\.run allowlist/,
      )
    }
  })

  it('rejects non-allowlisted binaries and subcommands', () => {
    for (const hostile of ['rm -rf /', 'echo hi', 'git merge wt/agent-abc', 'git push origin main', 'git rebase main', 'curl http://x', 'npm run dev', 'npm install']) {
      expect(() => parsed(hostile), `expected rejection: ${hostile}`).toThrowError(
        /not in the repo\.run allowlist/,
      )
    }
  })

  it('rejects git commit --amend in both flag positions', () => {
    expect(() => parsed('git commit --amend')).toThrowError(/not in the repo\.run allowlist/)
    expect(() => parsed('git commit --amend -m x')).toThrowError(/not in the repo\.run allowlist/)
    expect(() => parsed('git commit -m x --amend')).toThrowError(/cannot be flags/)
    expect(() => parsed('git commit -m x -a')).toThrowError(/cannot be flags/)
  })

  it('rejects exact entries with extra or mutated args', () => {
    expect(() => parsed('npm test extra')).toThrowError(/allowlist/)
    expect(() => parsed('git status -s')).toThrowError(/allowlist/)
    expect(() => parsed('git log --oneline')).toThrowError(/allowlist/)
    expect(() => parsed('GIT STATUS')).toThrowError(/allowlist/)
    expect(() => parsed('npm run')).toThrowError(/allowlist/)
  })

  it('rejects path traversal and absolute escapes in path args', () => {
    expect(() => parsed('npx vitest run ../outside')).toThrowError(/\.\./)
    expect(() => parsed('git add ../outside')).toThrowError(/unsafe git add/)
    expect(() => parsed('mkdir ../escape')).toThrowError(/\.\./)
    expect(() => parsed('cp secret.txt ../../../tmp/x')).toThrowError(/\.\./)
    expect(() => parsed('mv ../a ../b')).toThrowError(/\.\./)
  })

  it('rejects flags on path-only commands (mkdir -p, cp -r, git add -A)', () => {
    expect(() => parsed('mkdir -p sub')).toThrowError(/worktree-relative/)
    expect(() => parsed('cp -r src dst')).toThrowError(/worktree-relative/)
    expect(() => parsed('git add -A')).toThrowError(/repo-relative/)
  })

  it('rejects empty and whitespace-only commands', () => {
    expect(() => parsed('')).toThrowError(/allowlist/)
    expect(() => parsed('   ')).toThrowError(/allowlist/)
  })

  it('rejects node with scripts outside scripts/ or none', () => {
    expect(() => parsed('node server.js')).toThrowError(/allowlist/)
    expect(() => parsed('node ../scripts/evil.mjs')).toThrowError(/allowlist/)
    expect(() => parsed('node')).toThrowError(/allowlist/)
    expect(() => parsed('node scripts/../server.js')).toThrowError(/\.\./)
  })
})
