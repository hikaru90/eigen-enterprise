import { describe, expect, it } from 'vitest'
import { artifactOfToolOutcome } from './artifact'

describe('artifactOfToolOutcome', () => {
  it('names the file an artifact write returned', () => {
    expect(artifactOfToolOutcome('artifacts.create', { artifact: { id: 'f1', kind: 'deck' } })).toEqual({ fileId: 'f1' })
    expect(artifactOfToolOutcome('artifacts.update', { artifact: { id: 'f2' } })).toEqual({ fileId: 'f2' })
  })

  it('names none for other tools, errors and approval waits', () => {
    expect(artifactOfToolOutcome('drive.write_text', { artifact: { id: 'f1' } })).toBeNull()
    expect(artifactOfToolOutcome('artifacts.create', { status: 'error', message: 'x' })).toBeNull()
    expect(artifactOfToolOutcome('artifacts.update', { status: 'approval_pending' })).toBeNull()
    expect(artifactOfToolOutcome('artifacts.read', { artifact: { id: 'f1' } })).toBeNull()
  })
})
