import { describe, expect, it } from 'vitest'
import { compareVersions, parseReleaseSource, pinnedFrom, releaseVersion, newestFrom } from './release-source.ts'

describe('parseReleaseSource (install.sh --from, recorded so Settings → Updates knows where releases come from)', () => {
  it('a GitHub releases URL — latest or pinned to a tag — records the repo', () => {
    for (const from of [
      'https://github.com/hikaru90/eigen-enterprise/releases/latest/download',
      'https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.16',
      'https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.16/',
    ]) {
      expect(parseReleaseSource(from)).toEqual({ kind: 'github', repo: 'hikaru90/eigen-enterprise' })
    }
  })

  it('an absolute directory (the files copied to the box; the local box mounts /release)', () => {
    expect(parseReleaseSource('/release')).toEqual({ kind: 'dir', path: '/release' })
    expect(parseReleaseSource('/root/release/')).toEqual({ kind: 'dir', path: '/root/release' })
  })

  it('any other release URL: one release there, like a directory', () => {
    expect(parseReleaseSource('https://releases.example.com/ee/')).toEqual({ kind: 'url', base: 'https://releases.example.com/ee' })
    expect(newestFrom({ kind: 'url', base: 'https://releases.example.com/ee' })).toBe('https://releases.example.com/ee')
  })

  it('refuses anything else in plain words (no guessing)', () => {
    expect(() => parseReleaseSource('release')).toThrow(/absolute directory or an http\(s\) release URL/)
    expect(() => parseReleaseSource('ftp://example.com/r')).toThrow(/absolute directory or an http\(s\) release URL/)
    expect(() => parseReleaseSource('http://github.com/a/b/releases/latest/download')).toThrow(/https/)
  })
})

describe('where to read the newest release, and the pinned release to install', () => {
  const gh = { kind: 'github', repo: 'hikaru90/eigen-enterprise' } as const
  const dir = { kind: 'dir', path: '/release' } as const

  it('GitHub: latest/download to look, the tag of that version to install', () => {
    expect(newestFrom(gh)).toBe('https://github.com/hikaru90/eigen-enterprise/releases/latest/download')
    expect(pinnedFrom(gh, 'eigenenterprise-0.5.17-14424746613a')).toBe('https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.17')
  })

  it('a directory holds one release: the same place for both', () => {
    expect(newestFrom(dir)).toBe('/release')
    expect(pinnedFrom(dir, 'eigenenterprise-0.5.17-14424746613a')).toBe('/release')
  })
})

describe('versions', () => {
  it('reads the version from a release or tarball name', () => {
    expect(releaseVersion('eigenenterprise-0.5.17-14424746613a')).toBe('0.5.17')
    expect(releaseVersion('eigenenterprise-0.5.16-14424746613a-linux-arm64.tar.gz')).toBe('0.5.16')
    expect(() => releaseVersion('nope')).toThrow(/not a release name/)
  })

  it('compares numerically', () => {
    expect(compareVersions('0.5.17', '0.5.16')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.5.16', '0.5.16')).toBe(0)
    expect(compareVersions('0.5.2', '0.5.16')).toBe(-1)
  })
})
