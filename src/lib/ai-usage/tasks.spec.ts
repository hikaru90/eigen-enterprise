import { describe, expect, it } from 'vitest'
import { AI_PRODUCT_IDS, AI_PRODUCTS, AI_TASK_IDS, AI_TASKS, aiTaskOperation, isAiTaskId } from './tasks'

describe('AI task catalog', () => {
  it('lists every AI-enabled product, in one order', () => {
    expect(AI_PRODUCT_IDS).toEqual([
      'assistant',
      'coworkers',
      'memory',
      'brain',
      'decisions',
      'calls',
      'contacts',
      'calendar',
      'handover',
      'repos',
      'branding',
      'website',
      'drive',
      'contribute',
      'email',
      'speech',
      'setup',
    ])
    for (const id of AI_PRODUCT_IDS) {
      expect(AI_PRODUCTS[id].label).not.toBe('')
      expect(AI_PRODUCTS[id].description).not.toBe('')
    }
  })

  it('gives every task a known product, a label and the product as its id prefix', () => {
    for (const id of AI_TASK_IDS) {
      const task = AI_TASKS[id]
      expect(AI_PRODUCT_IDS).toContain(task.product)
      expect(task.label).not.toBe('')
      expect(id.startsWith(`${task.product}.`)).toBe(true)
    }
  })

  it('keeps the operation segment the cost log used before tasks existed', () => {
    expect(aiTaskOperation('memory.enrich_thought_bundle')).toBe('enrich_thought_bundle')
    expect(aiTaskOperation('brain.retrieval_rerank')).toBe('retrieval_rerank')
    expect(aiTaskOperation('assistant.turn')).toBe('durable_agent')
    expect(aiTaskOperation('coworkers.turn')).toBe('durable_agent')
    expect(aiTaskOperation('website.page_audience')).toBe('website_page_audience')
    expect(aiTaskOperation('branding.extract')).toBe('brand_extract')
    // calls that never named themselves logged as llm.chat.chat.*
    expect(aiTaskOperation('memory.split_capture')).toBe('chat')
  })

  it('knows its own ids only', () => {
    expect(isAiTaskId('speech.stt')).toBe(true)
    expect(isAiTaskId('speech.nope')).toBe(false)
    expect(isAiTaskId('toString')).toBe(false)
  })
})
