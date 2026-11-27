import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_TASK_IDS, aiTaskOperation, isAiTaskId } from './tasks'

/** Migration 0190 names the legacy operation names by hand: hold them against the catalog. */
const sql = readFileSync(path.resolve('drizzle/0190_activity_call_task_model.sql'), 'utf8')
const chatTable = sql.slice(sql.indexOf('-- Backfill 1'), sql.indexOf('AS legacy(name, task)'))
const legacy = new Map([...chatTable.matchAll(/\('([a-z0-9_]+)', '([a-z_.]+)'\)/g)].map((m) => [m[1]!, m[2]!]))

describe('migration 0190: legacy operation → task', () => {
  it('maps only to tasks the catalog has', () => {
    expect(legacy.size).toBeGreaterThan(30)
    for (const task of legacy.values()) expect(isAiTaskId(task), task).toBe(true)
  })

  it('maps every task that kept an old operation name (the durable agent by who was billed)', () => {
    for (const id of AI_TASK_IDS) {
      const op = aiTaskOperation(id)
      if (op === 'chat' || op === 'durable_agent') continue
      expect(legacy.get(op), op).toBe(id)
    }
  })

  it('never guesses the calls that named no purpose', () => {
    expect(legacy.has('chat')).toBe(false)
    expect(sql).not.toContain('llm.embedding')
    expect(sql).not.toMatch(/\bLIKE\b|~/i)
  })
})
