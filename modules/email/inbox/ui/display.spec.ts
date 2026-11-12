import { describe, expect, it } from 'vitest'
import { fileSize, moveActions, personFull, personLabel, shortWhen } from './display'

describe('Inbox display helpers', () => {
  it('offers the moves that fit the folder; Spam offers "Not spam" back to the inbox', () => {
    expect(moveActions('inbox').map((a) => a.label)).toEqual(['Archive', 'Spam', 'Trash'])
    expect(moveActions('spam')).toEqual([
      { folder: 'inbox', label: 'Not spam' },
      { folder: 'trash', label: 'Trash' },
    ])
    expect(moveActions('trash')).toEqual([{ folder: 'inbox', label: 'Back to inbox' }])
    expect(moveActions('archive').map((a) => a.folder)).toEqual(['inbox', 'spam', 'trash'])
    expect(moveActions('sent').map((a) => a.folder)).toEqual(['trash'])
  })

  it('names people by name, else address', () => {
    expect(personLabel({ name: 'Mara', address: 'm@x' })).toBe('Mara')
    expect(personLabel({ name: null, address: 'm@x' })).toBe('m@x')
    expect(personFull({ name: 'Mara', address: 'm@x' })).toBe('Mara <m@x>')
  })

  it('shows the time today, the day this year, the full date before', () => {
    const now = new Date(2026, 10, 12, 15, 0)
    expect(shortWhen(new Date(2026, 10, 12, 9, 5).toISOString(), now, 'en-GB')).toBe('09:05')
    expect(shortWhen(new Date(2026, 2, 3, 9, 5).toISOString(), now, 'en-GB')).toBe('3 Mar')
    expect(shortWhen(new Date(2025, 2, 3, 9, 5).toISOString(), now, 'en-GB')).toBe('3 Mar 2025')
  })

  it('sizes files', () => {
    expect([fileSize(10), fileSize(2048), fileSize(3 * 1024 * 1024)]).toEqual(['10 B', '2 KB', '3.0 MB'])
  })
})
