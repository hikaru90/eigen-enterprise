import type { GuestPageView } from '../../../modules/calls/service'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { ActiveCall } from './active-call.svelte'
import { fakeCall, fakeEnv, FakeRoom, fakeToken } from './fake-room'
import GuestJoin from './guest-join.svelte'

/** The public guest page (proposal 844bab56): link states, name → preview → join. No server, no LiveKit. */

const view = (over: Partial<GuestPageView> = {}): GuestPageView => ({
  status: 'ok',
  title: 'Kick-off',
  hostName: 'Ann Example',
  companyName: 'Kindred Digital Labs',
  scheduledStart: '2026-11-18T10:00:00.000Z',
  scheduledEnd: '2026-11-18T11:00:00.000Z',
  opensAt: '2026-11-18T09:45:00.000Z',
  closesAt: '2026-11-18T11:15:00.000Z',
  name: null,
  identity: 'guest:g1',
  ...over,
})

const guestCall = () =>
  fakeCall({
    contextKind: 'meeting',
    contextId: null,
    title: 'Kick-off',
    state: 'scheduled',
    startedBy: 'ann',
    participants: [{ userId: 'guest:g1', name: 'Guest', guest: true, response: 'accepted', joinedAt: null, leftAt: null, inRoom: false }],
  })

function mount(props: { view: GuestPageView | null; media?: 'ok' | 'denied' }) {
  const room = new FakeRoom()
  const names: string[] = []
  const client = {
    accept: vi.fn(async () => guestCall()),
    token: vi.fn(async () => fakeToken),
    hangup: vi.fn(async () => guestCall()),
    get: vi.fn(async () => guestCall()),
  }
  const makeActive = vi.fn((name: () => string) => {
    names.push(name())
    return new ActiveCall({ client: { ...client, token: vi.fn(async () => (names.push(name()), fakeToken)) }, createRoom: async () => room, env: () => fakeEnv() })
  })
  const stop = vi.fn()
  const getMedia = vi.fn(async () => {
    if (props.media === 'denied') throw new DOMException('Permission denied', 'NotAllowedError')
    const s = new MediaStream()
    vi.spyOn(s, 'getTracks').mockReturnValue([{ stop, kind: 'video', enabled: true } as unknown as MediaStreamTrack])
    return s
  })
  render(GuestJoin, { props: { view: props.view, call: props.view ? guestCall() : null, makeActive, getMedia } as never })
  return { room, names, makeActive, getMedia, stop }
}

describe('guest page link states', () => {
  it('unknown link: says so, nothing to join', async () => {
    mount({ view: null })
    await expect.element(page.getByTestId('guest-state')).toHaveAttribute('data-status', 'not_found')
    await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('This link doesn’t work')
    expect(page.getByTestId('guest-name').elements()).toHaveLength(0)
  })

  it.each([
    ['too_early', /opens at/i],
    ['expired', /has expired/i],
    ['over', /is over/i],
    ['revoked', /withdrew/i],
  ] as const)('%s: a clear page, no join', async (status, text) => {
    mount({ view: view({ status }) })
    await expect.element(page.getByTestId('guest-state')).toHaveAttribute('data-status', status)
    await expect.element(page.getByTestId('guest-page')).toHaveTextContent(text)
    expect(page.getByTestId('guest-name').elements()).toHaveLength(0)
  })

})

describe('guest page joining', () => {
  it('name first; then a camera + mic preview; join with the chosen devices; the call view shows the room', async () => {
    const { room, names, stop, getMedia } = mount({ view: view() })
    await expect.element(page.getByText(/Ann Example \(Kindred Digital Labs\) invited you/)).toBeVisible()
    await page.getByTestId('guest-continue').click()
    await expect.element(page.getByTestId('guest-error')).toHaveTextContent('Enter your name')
    await page.getByLabelText('Your name').fill('Ony Kunde')
    await page.getByTestId('guest-continue').click()
    await expect.element(page.getByTestId('guest-preview')).toBeVisible()
    expect(getMedia).toHaveBeenCalledWith({ video: true, audio: true })
    await page.getByRole('button', { name: 'Turn camera off' }).click()
    await page.getByTestId('guest-join').click()
    expect(stop).toHaveBeenCalled()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    expect(names).toContain('Ony Kunde')
    expect(room.devices).toMatchObject({ microphone: true, camera: false })
  })

  it('camera / mic refused: says how to allow it, still lets them join with devices off', async () => {
    const { room } = mount({ view: view(), media: 'denied' })
    await page.getByLabelText('Your name').fill('Ony')
    await page.getByTestId('guest-continue').click()
    await expect.element(page.getByTestId('guest-media-problem')).toHaveTextContent(/allow/i)
    await page.getByTestId('guest-join').click()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    expect(room.devices).toMatchObject({ microphone: false, camera: false })
  })
})
