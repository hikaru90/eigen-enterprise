import { describe, expect, it } from 'vitest'
import { driveSection } from './sections'

describe('driveSection', () => {
  it('section pages are their own section', () => {
    expect(driveSection('/drive', null)).toBe('mine')
    expect(driveSection('/drive/', null)).toBe('mine')
    expect(driveSection('/drive/shared', null)).toBe('shared')
    expect(driveSection('/drive/messages', null)).toBe('messages')
    expect(driveSection('/drive/archived', null)).toBe('archived')
    expect(driveSection('/drive/trash', null)).toBe('trash')
  })

  it('a folder or file belongs to the section its path starts in', () => {
    expect(driveSection('/drive/folder/f1', '/drive')).toBe('mine')
    expect(driveSection('/drive/folder/f1', '/drive/shared')).toBe('shared')
    expect(driveSection('/drive/file/x', '/messages')).toBe('messages')
  })

  it('no section while the root is unknown (an error page); an unknown root fails loud', () => {
    expect(driveSection('/drive/file/x', null)).toBeNull()
    expect(() => driveSection('/drive/file/x', '/elsewhere')).toThrow(/belongs to no section/)
  })
})
