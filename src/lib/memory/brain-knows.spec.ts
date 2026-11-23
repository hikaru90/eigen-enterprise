import { describe, expect, it } from 'vitest'
import { brainKnowsIndexState, brainKnowsSource, brainKnowsSourceLabel } from './brain-knows'

describe('brainKnowsSource — where a thought came from, as far as the row says', () => {
  it.each([
    [{ source: 'ui', author: 'user' }, { kind: 'app_input' }],
    [{ source: 'agent', author: 'user' }, { kind: 'assistant' }],
    [{ source: 'mcp', author: 'user' }, { kind: 'cli_or_mcp' }],
    [{ source: 'api', author: 'user' }, { kind: 'app' }],
    [{ source: 'eval', author: 'user' }, { kind: 'evaluation' }],
    [{ source: null, author: 'user' }, { kind: 'unrecorded' }],
  ] as const)('%o -> %o', (row, expected) => {
    expect(brainKnowsSource(row)).toEqual(expected)
  })

  it('a thought a connected agent wrote is that agent’s, whatever surface queued it', () => {
    expect(brainKnowsSource({ source: 'agent', author: 'agent', authorLabel: 'Coder' })).toEqual({
      kind: 'connected_agent',
      name: 'Coder',
    })
    expect(brainKnowsSource({ source: 'mcp', author: 'agent', authorLabel: null })).toEqual({
      kind: 'connected_agent',
      name: null,
    })
  })

  it('labels each source in a sentence a person reads', () => {
    expect(brainKnowsSourceLabel({ kind: 'assistant' })).toBe('Through the assistant')
    expect(brainKnowsSourceLabel({ kind: 'connected_agent', name: 'Coder' })).toBe('From Coder')
    expect(brainKnowsSourceLabel({ kind: 'connected_agent', name: null })).toBe('From a connected agent')
    expect(brainKnowsSourceLabel({ kind: 'unrecorded' })).toBe('Source not recorded')
  })
})

describe('brainKnowsIndexState — indexed, pending or failed', () => {
  it('is indexed once enrichment completed', () => {
    expect(brainKnowsIndexState({ enrichmentComplete: true, queueStatus: 'complete' })).toBe('indexed')
    expect(brainKnowsIndexState({ enrichmentComplete: true, queueStatus: null })).toBe('indexed')
  })

  it('is failed when the queue gave up, or finished without completing enrichment', () => {
    expect(brainKnowsIndexState({ enrichmentComplete: false, queueStatus: 'failed' })).toBe('failed')
    expect(brainKnowsIndexState({ enrichmentComplete: false, queueStatus: 'complete' })).toBe('failed')
  })

  it('is indexing while the worker has it, pending while it waits', () => {
    expect(brainKnowsIndexState({ enrichmentComplete: false, queueStatus: 'processing' })).toBe('indexing')
    expect(brainKnowsIndexState({ enrichmentComplete: false, queueStatus: 'pending' })).toBe('pending')
    expect(brainKnowsIndexState({ enrichmentComplete: false, queueStatus: 'awaiting_confirmation' })).toBe('pending')
    expect(brainKnowsIndexState({ enrichmentComplete: false, queueStatus: null })).toBe('pending')
  })
})
