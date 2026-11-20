import { describe, expect, it } from 'vitest'
import { CRAWLED_TOOLS, crawlAsMember, type ToolExec } from './crawl'

const CONV = '11111111-1111-4111-8111-111111111111'

function fakeExec(log: Array<{ tool: string; input: unknown }>): ToolExec {
  return async (tool, input) => {
    log.push({ tool, input })
    switch (tool) {
      case 'messages.list_channels':
        return { conversations: [{ id: CONV, kind: 'channel', title: 'general' }] }
      case 'messages.read':
        return { messages: [{ id: 'm1', body: 'hello FJ-2207' }] }
      case 'drive.list':
        return (input as { folder_id: string | null }).folder_id === null
          ? { items: [{ type: 'folder', id: 'fo1', name: 'Sales' }, { type: 'file', id: 'fi1', name: 'a.md' }] }
          : { items: [{ type: 'file', id: 'fi2', name: 'b.md' }] }
      case 'drive.read':
        if ((input as { file_id: string }).file_id === 'fi2') throw new Error('PowerPoint deck: reading text is not supported yet.')
        return { text: 'doc' }
      case 'contacts.list':
        return { contacts: [{ id: 'c1', name: 'Dana' }] }
      default:
        return { ok: true }
    }
  }
}

describe('the tool-level crawl: everything a member’s brain turn could read', () => {
  it('lists, then reads what the lists name (conversations, Drive folders recursively, contacts)', async () => {
    const log: Array<{ tool: string; input: unknown }> = []
    const calls = await crawlAsMember(fakeExec(log), ['messages.list_channels', 'messages.read', 'drive.list', 'drive.read', 'contacts.list', 'contacts.get'], {
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
      memberIds: ['a', 'b'],
    })
    expect(log).toContainEqual({ tool: 'messages.read', input: { conversation_id: CONV, limit: 200 } })
    expect(log).toContainEqual({ tool: 'drive.list', input: { folder_id: 'fo1' } })
    expect(log).toContainEqual({ tool: 'drive.read', input: { file_id: 'fi1' } })
    expect(log).toContainEqual({ tool: 'drive.read', input: { file_id: 'fi2' } })
    expect(log).toContainEqual({ tool: 'contacts.get', input: { id: 'c1' } })
    // a failing read is recorded, not thrown: the crawl measures, it does not stop
    const failed = calls.find((c) => c.tool === 'drive.read' && c.input.file_id === 'fi2')!
    expect(failed.ok).toBe(false)
    expect(failed.output).toContain('not supported yet')
    expect(calls.find((c) => c.tool === 'messages.read')!.output).toContain('FJ-2207')
  })

  it('calls only tools that are on the surface', async () => {
    const log: Array<{ tool: string; input: unknown }> = []
    await crawlAsMember(fakeExec(log), ['calls.list'], { from: 'x', to: 'y', memberIds: [] })
    expect(log.map((l) => l.tool)).toEqual(['calls.list'])
  })

  it('names the read tools it knows how to call (the report lists the surface it did not crawl)', () => {
    expect(CRAWLED_TOOLS).toContain('memory.retrieve_thoughts')
    expect(CRAWLED_TOOLS).toContain('calendar.list')
  })
})
