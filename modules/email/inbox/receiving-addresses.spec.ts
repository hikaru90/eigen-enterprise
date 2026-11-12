import { describe, expect, it } from 'vitest'
import { receivingRecipients } from './receiving-addresses'
import { addAlias, assignPersonalMailbox, createSharedMailbox, setMailboxDisabled } from './service'
import { fixture } from './test-fixtures'

describe('receivingRecipients', () => {
  it('every address of enabled mailboxes on receiving domains, aliases included, sorted', async () => {
    const f = fixture()
    f.deps.domains = async () => [
      { id: 'd-1', name: 'example.com' },
      { id: 'd-2', name: 'other.example' },
    ]
    await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana', domainId: 'd-1' })
    const sales = await createSharedMailbox(f.deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' })
    await addAlias(f.deps, 'olga', { mailboxId: sales.id, localPart: 'vertrieb', domainId: 'd-2' })
    const ben = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ben', localPart: 'ben', domainId: 'd-1' })
    await setMailboxDisabled(f.deps, 'olga', { mailboxId: ben.id, disabled: true })

    expect(await receivingRecipients(f.store, ['d-1'])).toEqual(['ana@example.com', 'sales@example.com'])
    expect(await receivingRecipients(f.store, ['d-1', 'd-2'])).toEqual(['ana@example.com', 'sales@example.com', 'vertrieb@other.example'])
    expect(await receivingRecipients(f.store, [])).toEqual([])
  })
})
