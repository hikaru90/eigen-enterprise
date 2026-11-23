import type { ClientCompany, Group, Teammate } from './types'

export const EMAIL_DOMAIN = 'northwind-studio.example'

/** Five teammates besides the owner (who plays the managing director). All made up. */
export const teammates: Teammate[] = [
  {
    handle: 'lena',
    firstName: 'Lena',
    lastName: 'Hoffmann',
    email: `lena.hoffmann@${EMAIL_DOMAIN}`,
    role: 'admin',
    title: 'Design lead',
  },
  {
    handle: 'jonas',
    firstName: 'Jonas',
    lastName: 'Becker',
    email: `jonas.becker@${EMAIL_DOMAIN}`,
    role: 'member',
    title: 'Senior developer',
  },
  {
    handle: 'mira',
    firstName: 'Mira',
    lastName: 'Petersen',
    email: `mira.petersen@${EMAIL_DOMAIN}`,
    role: 'admin',
    title: 'Project manager',
  },
  {
    handle: 'tarek',
    firstName: 'Tarek',
    lastName: 'Aydin',
    email: `tarek.aydin@${EMAIL_DOMAIN}`,
    role: 'member',
    title: 'Frontend developer',
  },
  {
    handle: 'sophie',
    firstName: 'Sophie',
    lastName: 'Wagner',
    email: `sophie.wagner@${EMAIL_DOMAIN}`,
    role: 'member',
    title: 'UX and content designer',
  },
]

export const groups: Group[] = [
  { name: 'Design', description: 'Brand, UX and content design.', members: ['lena', 'sophie'] },
  {
    name: 'Development',
    description: 'Frontend, backend and hosting.',
    members: ['jonas', 'tarek'],
  },
  {
    name: 'Client services',
    description: 'Proposals, planning and client contact.',
    members: ['owner', 'mira'],
  },
]

/** Fictitious client companies (every domain is a reserved .example name). */
export const companies: ClientCompany[] = [
  {
    id: 'acme',
    name: 'Acme Logistics GmbH',
    city: 'Hamburg',
    about: 'Freight forwarder with 14 depots in northern Germany.',
  },
  {
    id: 'elbtal',
    name: 'Elbtal Coffee Roasters',
    city: 'Hamburg',
    about: 'Specialty coffee roastery with two cafés and an online shop.',
  },
  {
    id: 'hafenblick',
    name: 'Hafenblick Hotels',
    city: 'Lübeck',
    about: 'Three boutique hotels on the Baltic coast.',
  },
  {
    id: 'kranich',
    name: 'Kranich Bikes',
    city: 'Bremen',
    about: 'Maker of cargo and city bikes, sold through dealers and online.',
  },
  {
    id: 'nordlicht',
    name: 'Nordlicht Energy',
    city: 'Kiel',
    about: 'Regional green-energy supplier for households and small businesses.',
  },
  {
    id: 'speicherstadt',
    name: 'Speicherstadt Museum Foundation',
    city: 'Hamburg',
    about: 'Foundation running a harbour history museum.',
  },
  {
    id: 'fjord',
    name: 'Fjord Health',
    city: 'Hamburg',
    about: 'Group of five physiotherapy clinics.',
  },
  {
    id: 'brueckner',
    name: 'Brückner & Partner',
    city: 'Hamburg',
    about: 'Law firm for employment and commercial law.',
  },
]
