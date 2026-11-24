/**
 * Runs install.sh's ee-slots block (install_ee) in a real shell against a throwaway root:
 * ee's own A/B slot, the link that runs and the one kept to go back to.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const INSTALL = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const BLOCK = /# BEGIN EE SLOTS[^\n]*\n([\s\S]*?)# END EE SLOTS/.exec(INSTALL)?.[1] ?? ''

function install(root: string, release: string, content: string) {
  const src = join(mkdtempSync(join(tmpdir(), 'ee-src-')), 'ee.mjs')
  writeFileSync(src, content)
  const r = spawnSync('sh', ['-euc', `${BLOCK}\ninstall_ee "$1" "$2" "$3"`, 'sh', src, release, root], { encoding: 'utf8' })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
}

const R1 = 'eigenenterprise-0.5.40-aaaaaaaaaaaa'
const R2 = 'eigenenterprise-0.5.41-bbbbbbbbbbbb'
const R3 = 'eigenenterprise-0.5.42-cccccccccccc'

describe('install.sh: ee upgrades itself from its own A/B slot', () => {
  it('the block exists', () => {
    expect(BLOCK).toContain('install_ee()')
  })

  it('the ee from before the slots is kept as the one to go back to', () => {
    const root = mkdtempSync(join(tmpdir(), 'ee-root-'))
    writeFileSync(join(root, 'ee.mjs'), 'old ee')
    install(root, R1, 'ee 1')
    expect(readlinkSync(join(root, 'ee.mjs'))).toBe(join(root, 'releases', R1, 'ee.mjs'))
    expect(readFileSync(join(root, 'ee.mjs'), 'utf8')).toBe('ee 1')
    expect(readlinkSync(join(root, 'ee.previous.mjs'))).toBe(join(root, 'releases', 'pre-slots', 'ee.mjs'))
    expect(readFileSync(join(root, 'ee.previous.mjs'), 'utf8')).toBe('old ee')
  })

  it('keeps two: the ee that runs and the one before it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ee-root-'))
    writeFileSync(join(root, 'ee.mjs'), 'old ee')
    install(root, R1, 'ee 1')
    install(root, R2, 'ee 2')
    install(root, R3, 'ee 3')
    expect(readFileSync(join(root, 'ee.mjs'), 'utf8')).toBe('ee 3')
    expect(readFileSync(join(root, 'ee.previous.mjs'), 'utf8')).toBe('ee 2')
    expect(existsSync(join(root, 'releases', R1))).toBe(false)
    expect(existsSync(join(root, 'releases', 'pre-slots'))).toBe(false)
  })

  it('a re-run of the same release (a repair) keeps the one to go back to', () => {
    const root = mkdtempSync(join(tmpdir(), 'ee-root-'))
    install(root, R1, 'ee 1')
    install(root, R2, 'ee 2')
    install(root, R2, 'ee 2')
    expect(readFileSync(join(root, 'ee.previous.mjs'), 'utf8')).toBe('ee 1')
    expect(existsSync(join(root, 'releases', R1, 'ee.mjs'))).toBe(true)
  })

  it('a fresh server has nothing to go back to', () => {
    const root = mkdtempSync(join(tmpdir(), 'ee-root-'))
    install(root, R1, 'ee 1')
    expect(readFileSync(join(root, 'ee.mjs'), 'utf8')).toBe('ee 1')
    expect(existsSync(join(root, 'ee.previous.mjs'))).toBe(false)
  })
})
