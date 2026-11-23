import type { BrandVoice, DriveDoc, WebsitePage } from '../types'

export const driveFolder = 'Northwind Studio'

export const docs: DriveDoc[] = [
  {
    name: 'Proposal: Kranich Bikes dealer locator and shop',
    author: 'owner',
    content: `# Proposal: Kranich Bikes dealer locator and shop

## Goal
One online shop for cargo and city bikes, and a dealer locator for 420 dealers in Germany, Austria and the Netherlands.

## Scope
- Shop on a headless commerce platform, replacing the current Magento install
- Dealer locator with map, filters (cargo, city, service) and test-ride booking
- Dealer data import from the existing dealer list (CSV)
- Three languages: German, English, Dutch

## Timeline
14 weeks from kick-off: discovery (2), design (4), build (6), launch and handover (2).

## Price
EUR 48,000 fixed, plus EUR 900 per month for hosting and maintenance.

## Team
Project manager: Mira Petersen · Design: Lena Hoffmann · Development: Jonas Becker, Tarek Aydin
`,
  },
  {
    name: 'Creative brief: Elbtal Coffee brand refresh',
    author: 'lena',
    content: `# Creative brief: Elbtal Coffee brand refresh

**Client:** Elbtal Coffee Roasters (Anna Schulz)

## Background
Specialty roastery with two cafés in Hamburg and an online shop. The current brand dates from 2016.

## What Anna asked for
- Less rustic, still warm
- Packaging that works on 250 g and 1 kg bags
- A subscription offer in the shop

## Direction picked in the moodboard round
Harbour blue with kraft paper, hand-drawn details kept small.

## Deliverables
Logo (two routes), colour and type, packaging for three origins, brand guidelines PDF, shop update.
`,
  },
  {
    name: 'Meeting notes: studio meeting (this Monday)',
    author: 'mira',
    content: `# Studio meeting

Present: everyone

## Projects
- **Acme relaunch:** homepage draft 2 sent; depot feed spec due; careers templates in progress.
- **Elbtal:** logo presentation this week.
- **Nordlicht:** Storybook demo on Thursday.
- **Harbour Voices:** opening next week; load test Thursday.

## Pipeline
- Kranich Bikes: proposal out, board meets next week.
- Fjord Health: discovery call to be booked.

## Actions
- Jonas: depot feed spec to Emre
- Sophie: final object texts to the curator
- Mira: photo shoot date with Acme
`,
  },
  {
    name: 'Meeting notes: Nordlicht component review',
    author: 'jonas',
    content: `# Nordlicht component review

With: Birte Jansen, Henrik Claassen (Nordlicht), Jonas, Lena, Tarek

- Reviewed the first 12 components in Storybook.
- Birte asked for a high-contrast theme for the customer portal.
- Henrik asked how tokens are published: npm package, versioned.
- Next: Storybook demo of buttons, forms and cards; tables after that.
`,
  },
  {
    name: 'Brief: Harbour Voices exhibition microsite',
    author: 'sophie',
    content: `# Brief: Harbour Voices microsite

**Client:** Speicherstadt Museum Foundation (Dr. Katrin Friedrich)

- 18 exhibition objects, each with a photo, a short text, audio and a transcript
- Works on phones in the exhibition (QR codes on the labels)
- German and English
- Launch: the evening before the opening

## Open items
- 4 audio files still to come from the museum
- Final proofreading of the object texts
`,
  },
  {
    name: 'Onboarding: how we work at Northwind',
    author: 'owner',
    content: `# How we work at Northwind

- Every client project has one project lead and lives in Memory as a project.
- Tasks for someone else are assigned to them, with a due day.
- Client conversations are logged on the contact, so anyone can see where things stand.
- Studio meeting: Mondays 9:30. Design crit: Fridays 11:00.
- Timesheets by Friday noon.
`,
  },
]

export const brand: BrandVoice = {
  locale: 'en',
  mission:
    'Northwind Studio designs and builds websites and brands for companies in northern Germany.',
  audience: 'Marketing leads and founders of small and mid-sized companies.',
  register: 'Plain, friendly, direct. Short sentences.',
  toneAttributes: [
    'clear but never curt',
    'warm without small talk',
    'confident, not boastful',
    'practical over clever',
  ],
  lexicon: [
    { term: 'synergy', kind: 'banned', replacement: 'working together' },
    { term: 'cutting-edge', kind: 'banned', replacement: 'modern' },
    { term: 'studio', kind: 'allowed' },
  ],
  examples: [
    {
      contentType: 'email',
      situation: 'Answering a new enquiry',
      body: 'Thanks for writing to us. We have time for a 30-minute call on Tuesday or Thursday; which day suits you?',
      label: 'good',
      rationale: 'Short, friendly, and ends with one clear next step.',
    },
    {
      contentType: 'email',
      situation: 'Answering a new enquiry',
      body: 'We are thrilled to leverage our cutting-edge synergies to transform your online presence!',
      label: 'bad',
      rationale: 'Buzzwords and hype instead of saying what happens next.',
    },
  ],
  glossary: [
    {
      term: 'Relaunch',
      definition: 'A full rebuild of a client website: content, design and code.',
    },
    {
      term: 'Design system',
      definition: 'A shared library of components and design tokens a client’s teams build with.',
    },
  ],
}

export const pages: WebsitePage[] = [
  {
    slug: 'about',
    title: 'About Northwind Studio',
    body: `# About Northwind Studio

We are a design and web studio of six people in Hamburg. Since 2019 we have built websites, shops and brands for companies in northern Germany: logistics, coffee, hotels, energy and culture.
`,
  },
  {
    slug: 'services',
    title: 'Services',
    body: `# What we do

- **Websites and relaunches:** content, design, build and hosting in Germany
- **Brands:** logo, colour, type, packaging and guidelines
- **Design systems:** components and tokens your own team can build with
- **Shops:** headless commerce with subscriptions
`,
  },
  {
    slug: 'contact',
    title: 'Contact',
    body: `# Say hello

Northwind Studio · Hamburg

Write to hello@northwind-studio.example and we will answer within a day.
`,
  },
]
