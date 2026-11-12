import { describe, expect, it } from 'vitest'
import { KernelError } from '../errors'
import { toolErrorResult } from './tool-error'

/**
 * Owner, 2026-11-12: the assistant never switches back on a plugin a person
 * switched off. The fix (kernel.module_activate) is offered only for a module
 * that was never switched on; the structured `switchedOff` detail decides,
 * never the message.
 */
describe('toolErrorResult for module_inactive', () => {
  it('offers kernel.module_activate for a module that was never switched on', () => {
    const err = new KernelError('module_inactive', 'module website is not active; cannot execute website.list_pages', {
      module: 'website',
      tool: 'website.list_pages',
      switchedOff: false,
    })
    expect(toolErrorResult('website.list_pages', err).remediation).toEqual({
      module: 'website',
      fix: 'kernel.module_activate',
      input: { module_id: 'website' },
    })
  })

  it('offers no fix for a plugin a person switched off, and says plainly who can switch it on', () => {
    const err = new KernelError('module_inactive', 'module calls is switched off; cannot execute calls.start', {
      module: 'calls',
      tool: 'calls.start',
      switchedOff: true,
    })
    const result = toolErrorResult('calls.start', err)
    expect(result.remediation).toBeUndefined()
    expect(result).toMatchObject({ status: 'error', code: 'module_inactive', details: { module: 'calls', switchedOff: true } })
    expect(result.message).toContain('switched off')
    expect(result.message).toContain('Do not switch it back on yourself')
    expect(result.message).toContain('the owner or an admin')
    expect(result.message).toContain('Settings → Plugins')
  })

  it('offers no fix when the error does not say which (fail closed: never re-enable on a guess)', () => {
    const err = new KernelError('module_inactive', 'tool calls.start belongs to inactive module calls', { module: 'calls' })
    expect(toolErrorResult('calls.start', err).remediation).toBeUndefined()
  })
})
