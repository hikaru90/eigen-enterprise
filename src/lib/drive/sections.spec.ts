import { describe, expect, it } from 'vitest'
import { driveSection, githubButtonLabel, GITHUB_PAGE, GITHUB_SOURCE } from './sections'

describe('driveSection', () => {
  it('section pages are their own section', () => {
    expect(driveSection('/drive', null, [])).toBe('mine')
    expect(driveSection('/drive/', null, [])).toBe('mine')
    expect(driveSection('/drive/shared', null, [])).toBe('shared')
    expect(driveSection('/drive/messages', null, [])).toBe('messages')
    expect(driveSection('/drive/archived', null, [])).toBe('archived')
    expect(driveSection('/drive/trash', null, [])).toBe('trash')
  })

  it('a folder or file belongs to the section its path starts in', () => {
    expect(driveSection('/drive/folder/f1', '/drive', [])).toBe('mine')
    expect(driveSection('/drive/folder/f1', '/drive/shared', [])).toBe('shared')
    expect(driveSection('/drive/file/x', '/messages', [])).toBe('messages')
  })

  it('no section while the root is unknown (an error page); an unknown root fails loud', () => {
    expect(driveSection('/drive/file/x', null, [])).toBeNull()
    expect(() => driveSection('/drive/file/x', '/elsewhere', [])).toThrow(/belongs to no section/)
  })

  it('a source root is its own section: its folders and files belong to it (generic, from the roots that exist)', () => {
    const sources = [
      { source: 'repos', href: '/drive/folder/root-1' },
      { source: 'wiki', href: '/drive/folder/root-2' },
    ]
    expect(driveSection('/drive/folder/root-1', '/drive/folder/root-1', sources)).toBe('source:repos')
    expect(driveSection('/drive/file/x', '/drive/folder/root-2', sources)).toBe('source:wiki')
    expect(driveSection('/drive/folder/f1', '/drive', sources)).toBe('mine')
    expect(() => driveSection('/drive/file/x', '/drive/folder/root-3', sources)).toThrow(/belongs to no section/)
  })

  it('Drive → GitHub (the repos settings) is the GitHub folder\'s section once it exists, else the "Connect GitHub" entry', () => {
    expect(GITHUB_PAGE).toBe('/drive/github')
    expect(GITHUB_SOURCE).toBe('repos')
    expect(driveSection('/drive/github', null, [])).toBe('github')
    expect(driveSection('/drive/github/', null, [{ source: 'wiki', href: '/drive/folder/w' }])).toBe('github')
    expect(driveSection('/drive/github', null, [{ source: 'repos', href: '/drive/folder/root-1' }])).toBe('source:repos')
  })
})

describe('githubButtonLabel', () => {
  it('"Connect GitHub" while no repo is connected, "Manage repos" after', () => {
    expect(githubButtonLabel(0)).toBe('Connect GitHub')
    expect(githubButtonLabel(3)).toBe('Manage repos')
  })
})
