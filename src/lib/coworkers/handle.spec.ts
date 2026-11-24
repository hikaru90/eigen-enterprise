import { describe, expect, it } from 'vitest'
import { renderMessageMarkdown } from '$lib/messages/markdown'
import { coworkerEmail, coworkerSlugFromEmail, mentionNamesOf } from './handle'

const CW_ID = '1a2b3c4d-0000-4000-8000-000000000001'
const nova = { id: CW_ID, name: 'Nova Lee', email: coworkerEmail('nova-lee', CW_ID), kind: 'coworker' as const }
const olga = { id: 'u-olga', name: 'Olga Owner', email: 'olga@example.com', kind: 'human' as const }

describe('a co-worker’s @handle', () => {
  it('is read back from its address', () => {
    expect(coworkerSlugFromEmail(nova.email, CW_ID)).toBe('nova-lee')
  })

  it('fails loud on an address this code did not build', () => {
    expect(() => coworkerSlugFromEmail('nova@example.com', CW_ID)).toThrow(/not a co-worker address/)
  })
})

describe('mentionNamesOf (what Messages highlights as an @mention)', () => {
  it('a person: full and first name', () => {
    expect(mentionNamesOf(olga)).toEqual(['Olga Owner', 'Olga'])
  })

  it('a co-worker: its handle only — the token that asks it for a turn, not its name', () => {
    expect(mentionNamesOf(nova)).toEqual(['nova-lee'])
  })

  it('highlights the whole handle of a co-worker, and not its first name alone', () => {
    const names = [...mentionNamesOf(olga), ...mentionNamesOf(nova)]
    const whole = renderMessageMarkdown('@nova-lee what is our story?', { names })
    expect(whole).toContain('<span data-mention="other">@nova-lee</span>')
    const first = renderMessageMarkdown('@Nova what is our story?', { names })
    expect(first).not.toContain('data-mention')
  })
})
