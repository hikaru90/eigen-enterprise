import { describe, expect, it } from 'vitest'
import { buildJudgeMessages, JUDGE_LOG_CONTEXT, JUDGE_MAX_ATTEMPTS, judgeProposal, parseJudgeOutput } from './judge'
import { judged } from './test-fixtures'

const candidate = { id: 'c1', title: 'Dark mode', kind: 'idea' as const, area: 'everywhere' as const, status: 'requested' as const }

describe('contribute judge', () => {
  it('shows the full catalog and the candidates, and says when there are none', () => {
    const [system, user] = buildJudgeMessages('Kindred', 'Add a dark theme', [candidate])
    expect(system.content).toContain('"polish"')
    expect(system.content).toContain('"messages"')
    expect(system.content).toContain('Kindred')
    expect(user.content).toContain('id: c1 | idea in everywhere | requested | "Dark mode"')
    const [, empty] = buildJudgeMessages(null, 'x', [])
    expect(empty.content).toContain('duplicate_of must be null')
  })

  it('parses a valid answer', () => {
    const r = judged({ kind: 'bug', area: 'messages', duplicate_of: null, reason: 'broken' })
    expect(parseJudgeOutput(r, new Set())).toEqual({ kind: 'bug', area: 'messages', duplicateOfId: null })
  })

  it('accepts a fenced answer naming a candidate', () => {
    const r = { choices: [{ message: { content: '```json\n{"kind":"idea","area":"everywhere","duplicate_of":"c1"}\n```' } }] }
    expect(parseJudgeOutput(r, new Set(['c1'])).duplicateOfId).toBe('c1')
  })

  it('rejects an invented candidate id, an unknown kind and an unknown area', () => {
    expect(() => parseJudgeOutput(judged({ kind: 'idea', area: 'drive', duplicate_of: 'zz' }), new Set(['c1']))).toThrow(/not one of the candidates/)
    expect(() => parseJudgeOutput(judged({ kind: 'feature', area: 'drive', duplicate_of: null }), new Set())).toThrow(/schema/)
    expect(() => parseJudgeOutput(judged({ kind: 'idea', area: 'kitchen', duplicate_of: null }), new Set())).toThrow(/schema/)
  })

  it('goes through the gateway as JSON at temperature 0 with its log context', async () => {
    const calls: unknown[] = []
    const decision = await judgeProposal(
      async (input) => {
        calls.push(input)
        return judged({ kind: 'polish', area: 'drive', duplicate_of: null })
      },
      { userId: 'ana', companyName: null, title: 'Bigger icons', candidates: [] },
    )
    expect(decision).toEqual({ kind: 'polish', area: 'drive', duplicateOfId: null })
    expect(calls).toEqual([expect.objectContaining({ userId: 'ana', temperature: 0, responseFormat: 'json_object', logContext: JUDGE_LOG_CONTEXT })])
  })

  it('retries a bad answer, then fails loud (502) — no fallback kind', async () => {
    let n = 0
    const chat = async () => {
      n++
      return judged({ kind: 'nope' })
    }
    await expect(judgeProposal(chat, { userId: 'ana', companyName: null, title: 'x', candidates: [] })).rejects.toMatchObject({
      code: 'upstream',
      message: expect.stringMatching(/Couldn't check your proposal/),
    })
    expect(n).toBe(JUDGE_MAX_ATTEMPTS)
  })

  it('does not retry a gateway error (no provider, no credits): it surfaces as-is', async () => {
    let n = 0
    const chat = async () => {
      n++
      throw new Error('No AI provider is set up')
    }
    await expect(judgeProposal(chat, { userId: 'ana', companyName: null, title: 'x', candidates: [] })).rejects.toThrow('No AI provider is set up')
    expect(n).toBe(1)
  })
})
