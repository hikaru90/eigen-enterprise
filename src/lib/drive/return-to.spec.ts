import { describe, expect, it } from 'vitest'
import { safeReturnTo } from './return-to'

describe('safeReturnTo', () => {
  it('accepts /messages paths with optional conversation and thread query params', () => {
    expect(safeReturnTo('/messages')).toEqual({ href: '/messages', label: 'Messages' })
    expect(safeReturnTo('/messages?c=conv-1')).toEqual({
      href: '/messages?c=conv-1',
      label: 'Messages',
    })
    expect(safeReturnTo('/messages?c=conv-1&t=msg-2')).toEqual({
      href: '/messages?c=conv-1&t=msg-2',
      label: 'Messages',
    })
  })

  it('returns null for empty or missing values', () => {
    expect(safeReturnTo(null)).toBeNull()
    expect(safeReturnTo(undefined)).toBeNull()
    expect(safeReturnTo('')).toBeNull()
    expect(safeReturnTo('   ')).toBeNull()
  })

  it('rejects non-/messages paths', () => {
    expect(safeReturnTo('/drive')).toBeNull()
    expect(safeReturnTo('/settings')).toBeNull()
    expect(safeReturnTo('/messagesevil')).toBeNull()
    expect(safeReturnTo('/messages-other')).toBeNull()
  })

  it('rejects protocol-relative URLs and schemes', () => {
    expect(safeReturnTo('//evil.com/messages')).toBeNull()
    expect(safeReturnTo('///evil.com')).toBeNull()
    expect(safeReturnTo('https://evil.com/messages')).toBeNull()
    expect(safeReturnTo('http://localhost/messages')).toBeNull()
    expect(safeReturnTo('javascript:alert(1)')).toBeNull()
    expect(safeReturnTo('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('rejects path traversal and backslashes', () => {
    expect(safeReturnTo('/messages/../settings')).toBeNull()
    expect(safeReturnTo('/messages/..')).toBeNull()
    expect(safeReturnTo('/messages/%2e%2e/settings')).toBeNull()
    expect(safeReturnTo('/messages?c=a..b')).toBeNull()
    expect(safeReturnTo('/messages\\evil')).toBeNull()
    expect(safeReturnTo('/\\evil.com')).toBeNull()
  })

  it('rejects control characters', () => {
    expect(safeReturnTo('/messages\r\nSet-Cookie: x')).toBeNull()
    expect(safeReturnTo('/messages\x00')).toBeNull()
    expect(safeReturnTo('/messages\t')).toBeNull()
    expect(safeReturnTo('/messages\x7f')).toBeNull()
  })
})
