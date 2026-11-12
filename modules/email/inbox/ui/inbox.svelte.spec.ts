import type { ComposeDraft } from '../send'
import type { MessageListItem, ReaderView } from '../view'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ComposeForm from './compose-form.svelte'
import FolderNav from './folder-nav.svelte'
import MailReader from './mail-reader.svelte'
import MessageList from './message-list.svelte'

const zero = { total: 0, unread: 0 }
const folders = [
  { folder: 'inbox' as const, label: 'Inbox', total: 3, unread: 2 },
  { folder: 'sent' as const, label: 'Sent', total: 4, unread: 4 },
  { folder: 'spam' as const, label: 'Spam', ...zero },
  { folder: 'trash' as const, label: 'Trash', ...zero },
  { folder: 'archive' as const, label: 'Archive', ...zero },
]

const item = (over: Partial<MessageListItem> = {}): MessageListItem => ({
  id: 'm1',
  from: { name: 'Mara Voss', address: 'mara@sender.example' },
  subject: 'Quarterly numbers',
  snippet: 'Hi Ana, here are the numbers',
  receivedAt: '2026-11-12T08:00:00.000Z',
  unread: true,
  starred: false,
  ...over,
})

const reader = (over: Partial<ReaderView> = {}): ReaderView => ({
  id: 'm1',
  folder: 'inbox',
  subject: 'Quarterly numbers',
  unread: false,
  starred: false,
  remoteImagesBlocked: false,
  imagesShown: false,
  messages: [
    {
      id: 'm1',
      folder: 'inbox',
      from: { name: 'Mara Voss', address: 'mara@sender.example' },
      to: [{ name: null, address: 'ana@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Quarterly numbers',
      receivedAt: '2026-11-12T08:00:00.000Z',
      unread: false,
      starred: false,
      body: { kind: 'text', text: 'Hi Ana,\n\nhere are the numbers.' },
      attachments: [],
    },
  ],
  ...over,
})

describe('folder-nav.svelte', () => {
  it('lists the folders with unread counts (never for Sent) and marks the current one', async () => {
    render(FolderNav, { folders, current: 'inbox', href: (f: string) => `/m/email/inbox?folder=${f}` })
    const nav = page.getByRole('navigation', { name: 'Folders' })
    await expect.element(nav.getByRole('link', { name: /Inbox/ })).toHaveAttribute('aria-current', 'page')
    await expect.element(page.getByTestId('inbox-folder-inbox-unread')).toHaveTextContent('2 unread')
    await expect.element(nav.getByRole('link', { name: 'Sent', exact: true })).toHaveAttribute('href', '/m/email/inbox?folder=sent')
    await expect.element(page.getByTestId('inbox-folder-sent-unread')).not.toBeInTheDocument()
    await expect.element(nav.getByRole('link', { name: 'Spam' })).not.toHaveAttribute('aria-current')
  })
})

describe('message-list.svelte', () => {
  it('shows sender, subject, snippet, unread and star markers', async () => {
    render(MessageList, {
      messages: [item(), item({ id: 'm2', unread: false, starred: true, from: { name: null, address: 'jo@x.example' }, subject: '' })],
      selectedId: 'm2',
      label: 'Mail in Inbox',
      empty: 'No mail.',
      href: (id: string) => `/m/email/inbox?m=${id}`,
      onopen: () => {},
    })
    const list = page.getByRole('list', { name: 'Mail in Inbox' })
    await expect.element(list.getByRole('link', { name: /Unread\. Mara Voss.*Quarterly numbers.*Hi Ana/ })).toBeVisible()
    const second = page.getByTestId('inbox-item-m2')
    await expect.element(second).toHaveTextContent(/Starred\./)
    await expect.element(second).toHaveTextContent('jo@x.example')
    await expect.element(second).toHaveTextContent('(no subject)')
    await expect.element(second).toHaveAttribute('aria-current', 'true')
    await expect.element(second).toHaveAttribute('href', '/m/email/inbox?m=m2')
  })

  it('opening a mail goes through the page’s handler', async () => {
    const onopen = vi.fn((_: MessageListItem, e: MouseEvent) => e.preventDefault())
    render(MessageList, { messages: [item()], selectedId: null, label: 'Mail', empty: 'No mail.', href: () => '#m1', onopen })
    await page.getByTestId('inbox-item-m1').click()
    expect(onopen).toHaveBeenCalledTimes(1)
    expect(onopen.mock.calls[0]![0].id).toBe('m1')
  })

  it('says when a folder is empty', async () => {
    render(MessageList, { messages: [], selectedId: null, label: 'Mail', empty: 'Nothing in Spam.', href: () => '', onopen: () => {} })
    await expect.element(page.getByText('Nothing in Spam.')).toBeVisible()
  })
})

describe('mail-reader.svelte', () => {
  const base = { backHref: '/m/email/inbox', imagesHref: '/m/email/inbox?m=m1&images=1', submit: () => undefined }

  it('shows a plain-text mail as text, with the actions an inbox mail has', async () => {
    render(MailReader, { reader: reader(), ...base })
    await expect.element(page.getByRole('heading', { name: 'Quarterly numbers' })).toBeVisible()
    await expect.element(page.getByTestId('inbox-text-body')).toHaveTextContent('here are the numbers.')
    const actions = page.getByRole('group', { name: 'Actions for this mail' })
    for (const name of ['Archive', 'Spam', 'Trash', 'Mark unread', 'Star']) {
      await expect.element(actions.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await expect.element(page.getByRole('button', { name: 'Not spam' })).not.toBeInTheDocument()
    await expect.element(page.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/m/email/inbox')
  })

  it('in Spam it offers "Not spam" (a move back to the inbox)', async () => {
    render(MailReader, { reader: reader({ folder: 'spam', unread: true, starred: true }), ...base })
    const notSpam = page.getByRole('button', { name: 'Not spam' })
    await expect.element(notSpam).toBeVisible()
    const form = notSpam.element().closest('form')!
    expect(form.getAttribute('action')).toBe('?/move')
    expect(new FormData(form).get('folder')).toBe('inbox')
    expect(new FormData(form).get('messageId')).toBe('m1')
    await expect.element(page.getByRole('button', { name: 'Mark read' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Unstar' })).toBeVisible()
  })

  it('renders HTML in a sandboxed iframe without scripts or same-origin, and offers Show images', async () => {
    const r = reader({ remoteImagesBlocked: true })
    r.messages[0]!.body = { kind: 'html', srcdoc: '<!doctype html><p>Hello</p>', remoteImages: true }
    render(MailReader, { reader: r, ...base })
    const frame = page.getByTitle('Mail from Mara Voss').element() as HTMLIFrameElement
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox')
    expect(frame.getAttribute('srcdoc')).toBe('<!doctype html><p>Hello</p>')
    await expect.element(page.getByRole('link', { name: 'Show images' })).toHaveAttribute('href', '/m/email/inbox?m=m1&images=1')
  })

  it('lists attachments as downloads, a blocked one as blocked', async () => {
    const r = reader()
    r.messages[0]!.attachments = [
      { id: 'a1', filename: 'contract.pdf', contentType: 'application/pdf', sizeBytes: 2048, blocked: false, kept: true, href: '/m/email/inbox/attachments/a1' },
      { id: 'a2', filename: 'evil.exe', contentType: 'application/octet-stream', sizeBytes: 10, blocked: true, kept: true, href: '/m/email/inbox/attachments/a2' },
    ]
    render(MailReader, { reader: r, ...base })
    const list = page.getByRole('list', { name: 'Attachments' })
    await expect.element(list.getByRole('link', { name: /contract\.pdf/ })).toHaveAttribute('href', '/m/email/inbox/attachments/a1')
    await expect.element(page.getByTestId('inbox-attachment-blocked-a2')).toHaveTextContent('evil.exe · Blocked: Amazon found a virus')
    await expect.element(list.getByRole('link', { name: /evil\.exe/ })).not.toBeInTheDocument()
  })

  it('shows a thread oldest first and an action error', async () => {
    const r = reader()
    r.messages = [{ ...r.messages[0]!, id: 'm0', folder: 'archive', body: { kind: 'empty' } }, r.messages[0]!]
    render(MailReader, { reader: r, ...base, error: 'No such mail.' })
    await expect.element(page.getByRole('alert')).toHaveTextContent('No such mail.')
    const items = page.getByRole('list', { name: 'Mails in this conversation' }).getByRole('listitem').all()
    expect(items).toHaveLength(2)
    await expect.element(page.getByTestId('inbox-thread-m0')).toHaveTextContent('Archive')
    await expect.element(page.getByTestId('inbox-thread-m1')).toHaveAttribute('aria-current', 'true')
  })
})

describe('mail-reader.svelte: reply and forward (S5)', () => {
  const base = { backHref: '/m/email/inbox', imagesHref: '/m/email/inbox?m=m1&images=1', submit: () => undefined }

  it('offers Reply, Reply all and Forward of the opened mail when it can send', async () => {
    const compose = { reply: '/m/email/inbox?m=m1&compose=reply', replyAll: '/m/email/inbox?m=m1&compose=replyAll', forward: '/m/email/inbox?m=m1&compose=forward' }
    render(MailReader, { reader: reader(), ...base, compose })
    const actions = page.getByRole('group', { name: 'Actions for this mail' })
    await expect.element(actions.getByRole('link', { name: 'Reply', exact: true })).toHaveAttribute('href', compose.reply)
    await expect.element(actions.getByRole('link', { name: 'Reply all' })).toHaveAttribute('href', compose.replyAll)
    await expect.element(actions.getByRole('link', { name: 'Forward' })).toHaveAttribute('href', compose.forward)
  })

  it('offers none from a disabled mailbox; shows Bcc and unkept attachments of a sent copy', async () => {
    const r = reader({ folder: 'sent' })
    r.messages[0] = {
      ...r.messages[0]!,
      folder: 'sent',
      bcc: [{ name: 'Boss', address: 'boss@x.co' }],
      attachments: [{ id: 's1', filename: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 2048, blocked: false, kept: false, href: '/m/email/inbox/attachments/s1' }],
    }
    render(MailReader, { reader: r, ...base, compose: null })
    await expect.element(page.getByRole('link', { name: 'Reply', exact: true })).not.toBeInTheDocument()
    await expect.element(page.getByTestId('inbox-bcc')).toHaveTextContent('Bcc Boss <boss@x.co>')
    await expect.element(page.getByTestId('inbox-attachment-not-kept-s1')).toHaveTextContent('plan.pdf')
    await expect.element(page.getByRole('link', { name: /plan\.pdf/ })).not.toBeInTheDocument()
  })
})

describe('compose-form.svelte (S5)', () => {
  const draft = (over: Partial<ComposeDraft> = {}): ComposeDraft => ({
    mode: 'new',
    parentId: null,
    fromMailboxId: 'b1',
    fromChoices: [
      { id: 'b1', address: 'ana@example.com', name: 'Ana Lind' },
      { id: 'b2', address: 'sales@example.com', name: null },
    ],
    to: '',
    cc: '',
    subject: '',
    body: '',
    forwarded: [],
    notForwarded: [],
    blocked: null,
    ...over,
  })
  const props = { submit: () => undefined, discardHref: '/m/email/inbox' }

  it('new mail: From picker on the mailbox you are in, labelled fields, focus on To, Bcc behind a toggle', async () => {
    render(ComposeForm, { draft: draft(), ...props })
    await expect.element(page.getByRole('heading', { name: 'New mail' })).toBeVisible()
    await expect.element(page.getByLabelText('From')).toHaveValue('b1')
    await expect.element(page.getByLabelText('To', { exact: true })).toHaveFocus()
    await expect.element(page.getByLabelText('Bcc', { exact: true })).not.toBeInTheDocument()
    await page.getByRole('button', { name: 'Bcc' }).click()
    await expect.element(page.getByLabelText('Bcc', { exact: true })).toHaveFocus()
    for (const label of ['Cc', 'Subject', 'Message', 'Attach files (up to 25 MB together)']) await expect.element(page.getByLabelText(label, { exact: true })).toBeVisible()
    const form = page.getByTestId('compose').element().querySelector('form')!
    expect(form.getAttribute('action')).toBe('?/send')
    expect(form.getAttribute('enctype')).toBe('multipart/form-data')
    expect(new FormData(form).get('mode')).toBe('new')
    expect(new FormData(form).get('mailboxId')).toBe('b1')
  })

  it('a reply: fixed From, prefilled fields, focus in the text above the quote', async () => {
    render(ComposeForm, {
      draft: draft({ mode: 'reply', parentId: 'p1', fromChoices: [{ id: 'b1', address: 'ana@example.com', name: 'Ana Lind' }], to: 'mara@sender.example', subject: 'Re: Hi', body: '\n\nOn …, Mara wrote:\n> Hi' }),
      ...props,
    })
    await expect.element(page.getByTestId('compose-from')).toHaveTextContent('Ana Lind <ana@example.com>')
    await expect.element(page.getByLabelText('To', { exact: true })).toHaveValue('mara@sender.example')
    await expect.element(page.getByLabelText('Subject', { exact: true })).toHaveValue('Re: Hi')
    await expect.element(page.getByLabelText('Message')).toHaveFocus()
    const form = page.getByTestId('compose').element().querySelector('form')!
    expect(new FormData(form).get('parentId')).toBe('p1')
  })

  it('shows the error, keeps what was typed, and the busy state disables Send', async () => {
    const view = render(ComposeForm, { draft: draft(), ...props })
    await page.getByLabelText('To', { exact: true }).fill('typed@x.co')
    await view.rerender({ draft: draft(), ...props, busy: true, error: 'Amazon SES is still in its sandbox.' })
    await expect.element(page.getByRole('alert')).toHaveTextContent('Amazon SES is still in its sandbox.')
    await expect.element(page.getByLabelText('To', { exact: true })).toHaveValue('typed@x.co')
    await expect.element(page.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  })

  it('a blocked draft says why and Send is off; a forward lists what it carries and what it can’t', async () => {
    render(ComposeForm, {
      draft: draft({
        mode: 'forward',
        blocked: 'ana@example.com is disabled, so no mail can be sent from it.',
        forwarded: [{ filename: 'contract.pdf', sizeBytes: 2048 }],
        notForwarded: [{ filename: 'bad.exe', reason: 'Amazon found a virus in this mail' }],
      }),
      ...props,
    })
    await expect.element(page.getByTestId('compose-blocked')).toHaveTextContent('disabled, so no mail can be sent')
    await expect.element(page.getByRole('button', { name: 'Send' })).toBeDisabled()
    await expect.element(page.getByRole('list', { name: 'Forwarded attachments' })).toHaveTextContent('contract.pdf')
    await expect.element(page.getByTestId('compose-not-forwarded')).toHaveTextContent('bad.exe · not included: Amazon found a virus in this mail')
  })
})
