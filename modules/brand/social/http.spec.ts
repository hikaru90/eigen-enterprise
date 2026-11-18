import { describe, expect, it } from 'vitest'
import { parseUploadForm, socialJson } from './http'
import { SocialPostError } from './types'

describe('parseUploadForm', () => {
  it('reads the fields, one caption per chosen network, and the files', async () => {
    const form = new FormData()
    form.set('title', 'Team day')
    form.append('networks', 'instagram')
    form.append('networks', 'linkedin')
    form.set('caption_instagram', ' Our day out ')
    form.set('caption_x', 'not a chosen network')
    form.set('status', 'ready')
    form.set('plannedFor', '2026-12-01')
    form.append('files', new File([new Uint8Array([1, 2, 3])], 'one.jpg', { type: 'image/jpeg' }))
    const { fields, files } = await parseUploadForm(form)
    expect(fields).toEqual({
      title: 'Team day',
      networks: ['instagram', 'linkedin'],
      captions: { instagram: 'Our day out' },
      status: 'ready',
      plannedFor: '2026-12-01',
    })
    expect(files).toEqual([{ name: 'one.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) }])
  })

  it('refuses an upload without a network', async () => {
    const form = new FormData()
    form.set('title', 'X')
    await expect(parseUploadForm(form)).rejects.toThrow(/at least one network/)
  })
})

describe('socialJson', () => {
  it('maps library errors to their status with the plain sentence', async () => {
    const res = await socialJson(async () => {
      throw new SocialPostError('not_found', 'No social post x.')
    })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ message: 'No social post x.' })
    expect((await socialJson(async () => undefined)).status).toBe(204)
  })
})
