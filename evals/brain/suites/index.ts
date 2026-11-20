import { listSources } from '../fixture/audience'
import { factsFor, fillPlaceholders } from '../fixture/time'
import { LAYERS, MEMBER_KEYS, type CompanyFixture, type SuiteItem } from '../types'
import { DOES } from './does'
import { KEEPS } from './keeps'
import { KNOWS } from './knows'

export { DOES, KEEPS, KNOWS }
export const ALL_ITEMS: SuiteItem[] = [...KNOWS, ...DOES, ...KEEPS]

/**
 * Each item must test what it claims against the fixture's ground truth:
 * a Knows asker may read every source, a leak asker none of the protected
 * ones, every referenced object exists, every placeholder renders.
 */
export function validateSuites(f: CompanyFixture, items: SuiteItem[]): string[] {
  const errors: string[] = []
  const sources = new Map(listSources(f).map((s) => [s.id, s]))
  const facts = factsFor(f, new Date('2026-11-19T08:30:00Z'))
  const seen = new Set<string>()

  const readable = (item: SuiteItem, sourceId: string): boolean | null => {
    const s = sources.get(sourceId)
    if (!s) {
      errors.push(`${item.id}: unknown source ${sourceId}`)
      return null
    }
    return s.audience.has(item.asker)
  }
  const placeholders = (item: SuiteItem, text: string) => {
    try {
      fillPlaceholders(text, facts)
    } catch (err) {
      errors.push(`${item.id}: ${(err as Error).message}`)
    }
  }

  for (const item of items) {
    if (seen.has(item.id)) errors.push(`duplicate item id ${item.id}`)
    seen.add(item.id)
    if (!(LAYERS as readonly string[]).includes(item.layer)) errors.push(`${item.id}: unknown layer ${item.layer}`)
    if (!MEMBER_KEYS.includes(item.asker)) errors.push(`${item.id}: unknown asker ${item.asker}`)
    placeholders(item, item.prompt)

    if (item.suite === 'knows') {
      placeholders(item, item.gold)
      if (item.sources.length === 0) errors.push(`${item.id}: a Knows question names its sources`)
      for (const id of item.sources) {
        if (readable(item, id) === false) errors.push(`${item.id}: ${item.asker} may not read ${id}, so it cannot be a Knows question for them`)
      }
    } else if (item.suite === 'keeps' && item.kind === 'leak') {
      if (item.protects.length === 0) errors.push(`${item.id}: a leak test names what it protects`)
      for (const id of item.protects) {
        if (readable(item, id) === true) errors.push(`${item.id}: ${item.asker} may read ${id}, so it is no leak test for them`)
      }
    } else if (item.suite === 'keeps') {
      if (!MEMBER_KEYS.includes(item.about)) errors.push(`${item.id}: unknown person ${item.about}`)
    } else {
      const s = item.state
      const has = (list: Array<{ id: string }>, id: string, what: string) => {
        if (!list.some((x) => x.id === id)) errors.push(`${item.id}: unknown ${what} ${id}`)
      }
      if (s.check === 'calendar_event_moved') has(f.events, s.eventId, 'event')
      if (s.check === 'mail_reply_sent') has(f.mail, s.inReplyToMailId, 'mail')
      if (s.check === 'channel_message_posted') has(f.channels, s.channelId, 'channel')
      if (s.check === 'dm_message_posted') has(f.dms, s.dmId, 'DM')
      if (s.check === 'contact_logged') has(f.contacts, s.contactId, 'contact')
      if (s.check === 'drive_file_shared') has(f.drive, s.fileId, 'Drive file')
    }
  }
  return errors
}
