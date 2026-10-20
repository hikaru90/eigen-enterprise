import { describe, expect, it } from 'vitest'
import { kernelManifest } from './admin-tools'
import { agentAdminManifest } from './agent-admin'

describe('kernel machinery is internal (never in the owner’s nav, overview or /m pages)', () => {
  it('marks the kernel and agent-admin manifests internal', () => {
    expect(kernelManifest.internal).toBe(true)
    expect(agentAdminManifest.internal).toBe(true)
  })
})
