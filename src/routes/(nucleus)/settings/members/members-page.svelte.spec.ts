import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MembersPage from './+page.svelte'

const URL = 'https://k.test/invite?token=abcdefghijklmnopqrstuvwx'
const props = () =>
  ({
    data: { members: [], invites: [], groups: [], openJoin: false, me: { id: 'me', role: 'owner' }, companyName: 'Kindred' },
    form: { action: 'invite', inviteUrl: URL, inviteEmail: 'bea@k.test', emailed: false },
    params: {},
  }) as never

describe('Settings → Members: copying an invite link', () => {
  afterEach(() => vi.restoreAllMocks())

  it('copies the link and says so', async () => {
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(MembersPage, props())
    await page.getByTestId('invite-link-copy').click()
    await expect.element(page.getByTestId('invite-link-copy')).toHaveTextContent('Copied')
    expect(write).toHaveBeenCalledWith(URL)
    await expect.element(page.getByTestId('invite-link-copy-error')).not.toBeInTheDocument()
  })

  it('a refused copy says why and points to the field, instead of failing silently', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('Document is not focused.', 'NotAllowedError'))
    render(MembersPage, props())
    await page.getByTestId('invite-link-copy').click()
    await expect
      .element(page.getByTestId('invite-link-copy-error'))
      .toHaveTextContent('The link could not be copied (Document is not focused.). Select it in the field and copy it.')
    await expect.element(page.getByTestId('invite-link-copy')).toHaveTextContent('Copy link')
  })
})
