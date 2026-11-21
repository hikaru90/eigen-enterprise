import { describe, expect, it } from 'vitest'
import {
  editableTurn,
  liveTranscriptRows,
  TurnNotEditableError,
  type TranscriptRow,
} from './turn-edit'

const user = (id: string, metadata: Record<string, unknown> | null = null): TranscriptRow => ({
  id,
  role: 'user',
  metadata,
})
const reply = (id: string, metadata: Record<string, unknown> | null = null): TranscriptRow => ({
  id,
  role: 'assistant',
  metadata,
})

describe('liveTranscriptRows (what the chat shows after an edit)', () => {
  it('leaves out every row marked superseded and keeps the order of the rest', () => {
    const rows = [
      user('u1'),
      reply('a1'),
      user('u2', { supersededBy: 'u3' }),
      reply('t2', { variant: 'tool_preview', tool: 'x', supersededBy: 'u3' }),
      user('u3', { replaces: 'u2' }),
      reply('a3', { turnOf: 'u3' }),
    ]
    expect(liveTranscriptRows(rows).map((r) => r.id)).toEqual(['u1', 'a1', 'u3', 'a3'])
  })

  it('a reply that lands after the edit (the stopped run finished anyway) belongs to its superseded turn', () => {
    const rows = [
      user('u1', { supersededBy: 'u2' }),
      user('u2', { replaces: 'u1' }),
      reply('late', { turnOf: 'u1' }),
    ]
    expect(liveTranscriptRows(rows).map((r) => r.id)).toEqual(['u2'])
  })
})

describe('editableTurn (only the latest message, and only when nothing was decided after it)', () => {
  it('the latest message after a stopped or finished reply is editable', () => {
    expect(editableTurn([user('u1'), reply('a1'), user('u2'), reply('stopped')], 'u2')).toEqual({
      messageId: 'u2',
      isFirst: false,
    })
    expect(editableTurn([user('u1')], 'u1')).toEqual({ messageId: 'u1', isFirst: true })
    // A greeting before it: still the first exchange of the person, but not the first row.
    expect(editableTurn([reply('hello'), user('u1')], 'u1').isFirst).toBe(false)
  })

  it('refuses an older message, a superseded one, a reply, an unknown id, and a message an approval card followed', () => {
    const rows = [
      user('u1'),
      reply('a1'),
      user('u2', { supersededBy: 'u3' }),
      user('u3', { replaces: 'u2' }),
      reply('card', { variant: 'approval_required', tool: 'website.publish', approvalId: 'ap1' }),
    ]
    for (const id of ['u1', 'u2', 'a1', 'nope', 'u3']) {
      expect(() => editableTurn(rows, id), id).toThrow(TurnNotEditableError)
    }
  })
})
