import type { DemoDataset } from '../types'
import { events } from './calendar'
import { contacts } from './contacts'
import { brand, docs, driveFolder, pages } from './documents'
import { memories } from './memories'
import { channels, messages } from './messages'
import { projects } from './projects'
import { companies, EMAIL_DOMAIN, groups, teammates } from './team'

/** Northwind Studio: a made-up 6-person design and web agency in Hamburg. */
export const northwind: DemoDataset = {
  companyName: 'Northwind Studio',
  emailDomain: EMAIL_DOMAIN,
  timeZone: 'Europe/Berlin',
  teammates,
  groups,
  companies,
  contacts,
  projects,
  channels,
  messages,
  events,
  driveFolder,
  docs,
  brand,
  pages,
  memories,
}
