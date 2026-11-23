import { describe, expect, it } from 'vitest'
import { createWebsiteFoundingTools, type FoundingPort } from './founding-tools'

function setup(admin = true) {
  const calls: unknown[] = []
  const port: FoundingPort = {
    isAdmin: async () => admin,
    found: async (principal, answers) => {
      calls.push([principal.id, answers])
      return { skipped: false, journeyId: 'j1', executed: 3, approvalPending: 1, completed: false }
    },
  }
  const [tool] = createWebsiteFoundingTools({ port: async () => port })
  return { tool: tool!, calls }
}

const owner = { principal: { id: 'u-owner', kind: 'human' as const, roles: ['admin'] }, requestId: 'r' }

describe('website.found_company', () => {
  it('runs the founding interview as the person, with the wizard’s answers', async () => {
    const { tool, calls } = setup()
    const out = await tool.handler(owner, { tone: 'warm', company_name: 'Kindred', positioning: 'AI-native OS' })
    expect(out).toMatchObject({ skipped: false, approvalPending: 1 })
    expect(calls).toEqual([['u-owner', { tone: 'warm', companyName: 'Kindred', positioning: 'AI-native OS' }]])
  })

  it('a member or a call as no person cannot found the website', async () => {
    await expect(setup(false).tool.handler(owner, { tone: 'x' })).rejects.toMatchObject({ code: 'permission_denied' })
    const agent = { principal: { id: 'a', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }
    await expect(setup().tool.handler(agent, { tone: 'x' })).rejects.toMatchObject({ code: 'no_person' })
  })
})
