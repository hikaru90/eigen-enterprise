import { describe, expect, it } from 'vitest'
import { EMPTY_REPLY_CAUSES, EmptyReplyError, emptyReplyCause, emptyReplyReport, emptyReplySentence } from './empty-reply'

describe('empty replies say why (wish c37fcfe6)', () => {
  it('maps the structured stop reason to a cause', () => {
    expect(emptyReplyCause({ stopReason: 'length' })).toBe('output_limit')
    expect(emptyReplyCause({ stopReason: 'error', rawStopReason: 'content_filter' })).toBe('content_filter')
    expect(emptyReplyCause({ stopReason: 'error', errorMessage: 'upstream 502' })).toBe('provider_error')
    expect(emptyReplyCause({ stopReason: 'toolUse' })).toBe('tool_loop_limit')
    expect(emptyReplyCause({ stopReason: 'aborted' })).toBe('aborted')
    expect(emptyReplyCause({ stopReason: 'stop' })).toBe('no_text')
    expect(() => emptyReplyCause({ stopReason: 'weird' })).toThrow(/unknown stop reason/)
  })

  it('every cause has a sentence that is not the old one', () => {
    for (const c of EMPTY_REPLY_CAUSES) {
      expect(emptyReplySentence(c)).not.toBe('The assistant did not produce a response.')
      expect(emptyReplySentence(c).length).toBeGreaterThan(40)
    }
  })

  it('the agent report carries the cause, the provider detail and next steps', () => {
    const report = emptyReplyReport(new EmptyReplyError('provider_error', 'upstream 502'), 'Answering a chat message')
    expect(report.error).toBe(emptyReplySentence('provider_error'))
    expect(report.agent).toMatchObject({ attempted: 'Answering a chat message', code: 'EmptyReplyError' })
    expect(report.agent.cause).toContain('upstream 502')
    expect(report.agent.nextSteps.length).toBeGreaterThan(1)
  })
})
