import { describe, expect, it } from 'vitest'
import { load } from './+page.server'

/** /m/website/apps moved to the module front page; the route redirects. */
describe('/m/website/apps (moved)', () => {
  it('redirects to /m/website', async () => {
    await expect(load({} as never)).rejects.toMatchObject({ status: 303, location: '/m/website' })
  })
})
