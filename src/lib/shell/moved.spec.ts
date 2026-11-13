import { describe, expect, it } from 'vitest'
import { movedHref } from './moved'

describe('movedHref (a moved page keeps its old links working)', () => {
  it.each([
    ['/m/email/people', '', '', '/m/email/people'],
    ['/m/email/people', 'new', '', '/m/email/people/new'],
    ['/m/email/people', 'abc', '?x=1', '/m/email/people/abc?x=1'],
    ['/drive/github', '', '?tag=a', '/drive/github?tag=a'],
  ])('%s + %s%s → %s', (base, rest, search, want) => {
    expect(movedHref(base, rest, search)).toBe(want)
  })
})
