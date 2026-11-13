import { describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { queueScan, runScanJob, scanHolder, SCAN_WORK, type StoredMailRef } from './mail-scan'

const personal = (folder = 'inbox'): StoredMailRef => ({ messageId: 'm-1', mailbox: { id: 'b-1', kind: 'personal', ownerUserId: 'ana' }, folder })

describe('which stored mail is read for appointments', () => {
  it('mail in the Inbox of a personal mailbox, for its holder', () => {
    expect(scanHolder(personal())).toBe('ana')
  })

  it('not spam or sent mail, not a shared mailbox, not a personal one without a holder', () => {
    expect(scanHolder(personal('spam'))).toBeNull()
    expect(scanHolder(personal('sent'))).toBeNull()
    expect(scanHolder({ ...personal(), mailbox: { id: 'b-2', kind: 'shared', ownerUserId: null } })).toBeNull()
    expect(scanHolder({ ...personal(), mailbox: { id: 'b-3', kind: 'personal', ownerUserId: null } })).toBeNull()
  })
})

describe('queueing the reading (the ingest hook)', () => {
  it('queues one job per mail for the holder, deduped by the mail', async () => {
    const enqueue = vi.fn(async () => {})
    expect(await queueScan({ pluginOn: async () => true, enqueue }, personal())).toBe(true)
    expect(enqueue).toHaveBeenCalledWith({ userId: 'ana', dedupeKey: 'calendar-proposal:m-1', payload: { messageId: 'm-1' } })
  })

  it('queues nothing while Calendar is switched off, or for mail that isn’t read', async () => {
    const enqueue = vi.fn(async () => {})
    const pluginOn = vi.fn(async () => false)
    expect(await queueScan({ pluginOn, enqueue }, personal())).toBe(false)
    expect(pluginOn).toHaveBeenCalledWith('calendar', SCAN_WORK)
    expect(await queueScan({ pluginOn: async () => true, enqueue }, personal('spam'))).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('running a queued reading', () => {
  const job = { userId: 'ana', payload: { messageId: 'm-1' } }

  it('reads the mail as its holder', async () => {
    const scan = vi.fn(async () => 'filed' as const)
    expect(await runScanJob({ pluginOn: async () => true, scan, log: () => {} }, job)).toBe('filed')
    expect(scan).toHaveBeenCalledWith({ userId: 'ana', messageId: 'm-1' })
  })

  it('skips while Calendar is switched off (the gateway is never asked)', async () => {
    const scan = vi.fn(async () => 'filed' as const)
    expect(await runScanJob({ pluginOn: async () => false, scan, log: () => {} }, job)).toBe('plugin_off')
    expect(scan).not.toHaveBeenCalled()
  })

  it('no company AI provider: done with one log line (ids only), not retried', async () => {
    const lines: unknown[] = []
    const scan = vi.fn(async () => {
      throw new LlmNotConfiguredError('no provider')
    })
    expect(await runScanJob({ pluginOn: async () => true, scan, log: (...a) => void lines.push(a) }, job)).toBe('no_provider')
    expect(lines).toEqual([['[calendar] no company AI provider: a received mail was not read for appointments', { messageId: 'm-1' }]])
  })

  it('any other failure throws (the queue retries); a payload without a mail fails loud', async () => {
    const scan = vi.fn(async () => {
      throw new Error('gateway 500')
    })
    await expect(runScanJob({ pluginOn: async () => true, scan, log: () => {} }, job)).rejects.toThrow('gateway 500')
    await expect(runScanJob({ pluginOn: async () => true, scan, log: () => {} }, { userId: 'ana', payload: {} })).rejects.toThrow(/messageId/)
  })
})
