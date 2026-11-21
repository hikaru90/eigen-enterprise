import { describe, expect, it } from 'vitest'
import { failed, refuse } from './route-errors'

describe('memory route errors', () => {
  it('refuse: the sentence, the status and what was attempted', async () => {
    const res = refuse(400, 'label is required', {
      attempted: 'Creating a project',
      input: { label: '' },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'label is required',
      agent: { attempted: 'Creating a project', input: { label: '' } },
    })
  })

  it('failed: the error message as the sentence, its class and cause for the agent', async () => {
    const res = failed(409, new Error('Project not found'), { attempted: 'Renaming a project' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: 'Project not found',
      agent: { attempted: 'Renaming a project', code: 'Error', cause: 'Project not found' },
    })
  })
})
