import type { MemoryNote } from '../types'

/**
 * Shared Memory notes the company brain answers from ("what's the status with
 * Acme?"). Observation, not judgment: what happened, who did what, when.
 * Raw thoughts stay private to their person (plan/shared-memory-voice-agent-tools.md),
 * so the brain's shared memories are notes.
 */
export const memories: MemoryNote[] = [
  // Acme Logistics
  {
    company: 'acme',
    author: 'mira',
    title: 'Acme Logistics: where the relaunch stands',
    body: 'Homepage draft 2 went to Daniela Kraus two days ago; she said she would send feedback by Thursday. Sitemap is approved (22 pages). Staging runs on German hosting. Go-live is planned for the end of next month.',
  },
  {
    company: 'acme',
    author: 'jonas',
    title: 'Acme depot feed',
    body: 'Emre Yilmaz (Acme IT) asked for a JSON endpoint for the 14 depots instead of the nightly CSV export. Jonas is writing the API spec; it is due tomorrow.',
  },
  {
    company: 'acme',
    author: 'sophie',
    title: 'Acme careers section',
    body: 'Nadia Petrov (HR) agreed on four employee stories. Two interviews are booked for Wednesday at Acme HQ. Tarek has the job list and job detail templates on staging.',
  },
  {
    company: 'acme',
    author: 'owner',
    title: 'Acme contract and budget',
    body: 'Holger Brandt signed the relaunch contract a month ago. Scope: 22 pages, careers section, depot finder. Pre-launch review with him is in the calendar for the week after next.',
  },
  {
    company: 'acme',
    author: 'mira',
    title: 'Acme photo shoot',
    body: 'Nadia suggested the Billbrook depot for the employee photo shoot. Mira is checking dates with the photographer.',
  },
  // Elbtal Coffee
  {
    company: 'elbtal',
    author: 'lena',
    title: 'Elbtal Coffee: brand refresh status',
    body: 'Anna Schulz picked the harbour-blue and kraft-paper direction in the moodboard round. Logo routes A (wordmark with crane) and B (round stamp) are presented this week. Brand guidelines are due in ten days.',
  },
  {
    company: 'elbtal',
    author: 'tarek',
    title: 'Elbtal subscription checkout',
    body: 'Paul Meier wants weekly and monthly coffee subscriptions that customers can pause. Tarek is building the checkout prototype. Product photos from Paul have not arrived yet.',
  },
  {
    company: 'elbtal',
    author: 'sophie',
    title: 'Elbtal About page',
    body: 'The About page text is written from the 40-minute interview with Carla Ruiz (head roaster) and is done.',
  },
  // Hafenblick Hotels
  {
    company: 'hafenblick',
    author: 'mira',
    title: 'Hafenblick Hotels: winter landing page',
    body: 'Marie Lorenz asked for a winter-offers landing page, live by mid-December. Northwind owes her a quote. Booking conversion last quarter was 3.1%.',
  },
  {
    company: 'hafenblick',
    author: 'jonas',
    title: 'Hafenblick booking widget',
    body: 'Felix Voss sent new rate plan codes; the booking widget was updated the same day.',
  },
  {
    company: 'hafenblick',
    author: 'sophie',
    title: 'Hafenblick content updates',
    body: 'Ines Engel sends event copy monthly. The November events are published.',
  },
  // Kranich Bikes
  {
    company: 'kranich',
    author: 'owner',
    title: 'Kranich Bikes: proposal status',
    body: 'Proposal sent a week ago: EUR 48,000, 14 weeks, shop plus dealer locator for 420 dealers. Tobias Wolf said their board decides at next week’s meeting. Follow-up call is in the calendar.',
  },
  {
    company: 'kranich',
    author: 'mira',
    title: 'Kranich Bikes requirements',
    body: 'The Bremen workshop collected 31 requirements. The shop runs on an old Magento install today. Julia Hahn would run the project on their side.',
  },
  {
    company: 'kranich',
    author: 'tarek',
    title: 'Kranich dealer data',
    body: 'Lukas Sommer manages the dealer list: 420 dealers in Germany, Austria and the Netherlands, kept as a CSV.',
  },
  // Nordlicht Energy
  {
    company: 'nordlicht',
    author: 'jonas',
    title: 'Nordlicht Energy: design system status',
    body: 'Tokens for two themes and the button, form and card components are done. Storybook demo with Birte Jansen is on Thursday. Tables and data grid come next. Project deadline is in about a month.',
  },
  {
    company: 'nordlicht',
    author: 'lena',
    title: 'Nordlicht high-contrast theme',
    body: 'Birte Jansen asked for a high-contrast theme for the customer portal at the last review. First pass has contrast ratios above 7:1. Jonas added it as a third token theme.',
  },
  {
    company: 'nordlicht',
    author: 'lena',
    title: 'Nordlicht icon set',
    body: '64 icons were sent to Svenja Ehlers for approval four days ago. No reply yet.',
  },
  {
    company: 'nordlicht',
    author: 'tarek',
    title: 'Nordlicht token package',
    body: 'Henrik Claassen asked how tokens are published. Answer: a versioned npm package; Jonas publishes it next week.',
  },
  // Speicherstadt Museum
  {
    company: 'speicherstadt',
    author: 'sophie',
    title: 'Harbour Voices microsite: status',
    body: 'The exhibition opens next week; go-live is the evening before. Dr. Katrin Friedrich returned corrections for 6 of 18 object texts; final proofreading is tomorrow. 4 of the 18 audio files are still to come from the museum.',
  },
  {
    company: 'speicherstadt',
    author: 'jonas',
    title: 'Harbour Voices load test',
    body: 'Load test is on Thursday. The press release goes out on opening day and links to the microsite.',
  },
  {
    company: 'speicherstadt',
    author: 'tarek',
    title: 'Harbour Voices performance',
    body: 'Lighthouse on staging: 98 performance, 100 accessibility. The audio player with transcripts works on mobile.',
  },
  {
    company: 'speicherstadt',
    author: 'mira',
    title: 'Harbour Voices launch communication',
    body: 'Ole Kaiser confirmed that the press release links to the microsite. Mira keeps the launch checklist.',
  },
  {
    company: 'speicherstadt',
    author: 'sophie',
    title: 'Museum school version',
    body: 'Greta Neumann mentioned a school-class version of the microsite for spring. No brief yet.',
  },
  // Fjord Health
  {
    company: 'fjord',
    author: 'owner',
    title: 'Fjord Health: new lead',
    body: 'Met Dr. Nils Berg at the Hamburg Startup Breakfast. Fjord Health runs five physiotherapy clinics and uses three different booking tools. Discovery call is booked for next Tuesday with Mira.',
  },
  {
    company: 'fjord',
    author: 'mira',
    title: 'Fjord Health contacts',
    body: 'Selin Arslan is the practice manager and day-to-day contact. Mats Lange runs their social media as a freelancer.',
  },
  // Brückner & Partner
  {
    company: 'brueckner',
    author: 'owner',
    title: 'Brückner & Partner retainer',
    body: 'Small maintenance retainer since 2023. Two new associates were added to the team page last month. Dr. Jan Roth mentioned a seminar booking site for next year.',
  },
  {
    company: 'brueckner',
    author: 'tarek',
    title: 'Brückner privacy page',
    body: 'Kai Scholz requested an updated privacy policy page; it was published two days later.',
  },
  // Studio
  {
    author: 'owner',
    title: 'Studio rhythm',
    body: 'Studio meeting Mondays 9:30, design crit Fridays 11:00. Timesheets are due Friday noon.',
  },
  {
    author: 'mira',
    title: 'Who leads which project',
    body: 'Acme relaunch: Mira. Elbtal brand refresh: Lena. Nordlicht design system: Jonas. Harbour Voices microsite: Sophie.',
  },
  {
    author: 'jonas',
    title: 'Hosting',
    body: 'Client sites run on German hosting. Staging environments exist for Acme, Elbtal and Harbour Voices.',
  },
  {
    author: 'lena',
    title: 'Design files',
    body: 'Figma files live in one team workspace per client. Exports for clients go into the client folder in Drive.',
  },
]
