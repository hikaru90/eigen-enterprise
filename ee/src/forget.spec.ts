import { describe, expect, it } from 'vitest'
import { forgetWorkload } from './forget.ts'
import { emptyJournal } from './journal.ts'

describe('forgetWorkload (removing an app removes its secrets and its history)', () => {
  it('drops the app’s secret scope and its events, keeps everything else, and records the removal', async () => {
    const journal = emptyJournal()
    journal.events.push(
      { id: '1', time: 't1', type: 'deploy.started', workload: 'shop', message: 'm1', data: {} },
      { id: '2', time: 't2', type: 'deploy.started', workload: 'blog', message: 'm2', data: {} },
      { id: '3', time: 't3', type: 'secret.set', workload: 'shop', message: 'secret DEMO_VAR set', data: {} },
    )
    const removed: string[] = []
    const secrets = { deleteWorkload: async (name: string) => void removed.push(name) }

    await forgetWorkload({ journal, secrets, name: 'shop', author: 'owner:ada', now: () => 't9', id: () => '9' })

    expect(removed).toEqual(['shop'])
    expect(journal.events.map((e) => e.id)).toEqual(['2', '9'])
    expect(journal.events.at(-1)).toMatchObject({
      type: 'app.removed',
      workload: null,
      message: 'app shop removed by owner:ada (its secrets and history were deleted)',
    })
  })
})
