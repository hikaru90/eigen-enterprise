import { describe, expect, it } from 'vitest'
import {
  dropTarget,
  isUnchanged,
  planDelete,
  planInsert,
  planMove,
  planPick,
  planRotate,
  turn,
  wholeDocument,
  type PageSlot,
} from './organise-plan'

const order = (plan: PageSlot[]) =>
  plan.map((s) => (s.kind === 'page' ? `${s.source}:${s.page}` : 'blank'))

describe('page plans (what the Organise mode stages)', () => {
  it('turns in quarter steps either way', () => {
    expect(turn(0, 90)).toBe(90)
    expect(turn(90, -180)).toBe(270)
    expect(turn(270, 90)).toBe(0)
    expect(() => turn(0, 30)).toThrow('Pages turn in steps of 90°, not 30°.')
  })

  it('rotates chosen pages; a blank page swaps its sides instead', () => {
    const plan = planInsert(wholeDocument(2), 1, [{ kind: 'blank', width: 612, height: 792 }])
    const turned = planRotate(plan, [0, 1], 90)
    expect(turned[0]).toEqual({ kind: 'page', source: 0, page: 0, rotate: 90 })
    expect(turned[1]).toEqual({ kind: 'blank', width: 792, height: 612 })
    expect(turned[2]).toBe(plan[2])
    expect(planRotate(turned, [0], -90)[0]).toMatchObject({ rotate: 0 })
  })

  it('moves a set to a position; a drop before a page maps to that position', () => {
    const plan = wholeDocument(5)
    expect(order(planMove(plan, [3, 4], 0))).toEqual(['0:3', '0:4', '0:0', '0:1', '0:2'])
    // Dragging pages 1 and 3 to just before page 4 (index 3): they land at 1 and 2.
    const to = dropTarget([0, 2], 3)
    expect(to).toBe(1)
    expect(order(planMove(plan, [0, 2], to))).toEqual(['0:1', '0:0', '0:2', '0:3', '0:4'])
    expect(order(planMove(plan, [0], dropTarget([0], 5)))).toEqual([
      '0:1',
      '0:2',
      '0:3',
      '0:4',
      '0:0',
    ])
  })

  it('deletes, picks and inserts; never an empty document', () => {
    const plan = wholeDocument(3)
    expect(order(planDelete(plan, [1]))).toEqual(['0:0', '0:2'])
    expect(() => planDelete(plan, [0, 1, 2])).toThrow('A PDF needs at least one page')
    expect(order(planPick(plan, [2, 0]))).toEqual(['0:0', '0:2'])
    expect(order(planInsert(plan, 3, wholeDocument(2, 1)))).toEqual([
      '0:0',
      '0:1',
      '0:2',
      '1:0',
      '1:1',
    ])
    expect(() => planInsert(plan, 4, [])).toThrow(
      'Pages can be inserted at position 1 to 4, not 5.',
    )
  })

  it('knows an untouched plan', () => {
    expect(isUnchanged(wholeDocument(3), 3)).toBe(true)
    expect(isUnchanged(planRotate(wholeDocument(3), [1], 90), 3)).toBe(false)
    expect(isUnchanged(planMove(wholeDocument(3), [2], 0), 3)).toBe(false)
  })
})
