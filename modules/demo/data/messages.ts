import type { Channel, Message } from '../types'

/** Public channels: open to everyone in the company, so every teammate can post. */
export const channels: Channel[] = [
  { id: 'general', name: 'general', topic: 'Studio-wide news and questions' },
  {
    id: 'acme',
    name: 'acme-relaunch',
    topic: 'Acme Logistics website relaunch',
  },
  {
    id: 'design',
    name: 'design-crit',
    topic: 'Show work in progress, get feedback',
  },
  {
    id: 'museum',
    name: 'harbour-voices',
    topic: 'Speicherstadt Museum microsite, opening soon',
  },
]

/** Posted in this order, each by its author. */
export const messages: Message[] = [
  {
    channel: 'general',
    author: 'owner',
    body: 'Morning all. Kranich Bikes has our proposal; their board meets next week. Fingers crossed.',
  },
  {
    channel: 'general',
    author: 'mira',
    body: 'Reminder: studio meeting Monday 9:30, I will put the agenda in Drive.',
  },
  {
    channel: 'general',
    author: 'jonas',
    body: 'The office Wi-Fi password changed, it is on the whiteboard in the kitchen.',
  },
  {
    channel: 'general',
    author: 'sophie',
    body: 'Who took the long HDMI cable from the meeting room? Asking for a client call at 2.',
  },
  { channel: 'general', author: 'tarek', body: 'It is in my bag, sorry. Putting it back now.' },
  {
    channel: 'general',
    author: 'lena',
    body: 'Elbtal logo presentation is today at 15:00, I booked the big room.',
  },
  {
    channel: 'general',
    author: 'owner',
    body: 'Met Dr. Berg from Fjord Health at the Startup Breakfast. Five clinics, three booking tools. I will set up a discovery call.',
  },
  { channel: 'general', author: 'mira', body: 'Timesheets for last week please, by Friday noon.' },
  {
    channel: 'general',
    author: 'jonas',
    body: 'Heads-up: I am out Friday afternoon, back Monday.',
  },
  {
    channel: 'general',
    author: 'sophie',
    body: 'Cake in the kitchen, Carla from Elbtal sent coffee and cake for the team.',
  },

  {
    channel: 'acme',
    author: 'mira',
    body: 'Homepage draft 2 went out to Daniela yesterday. She promised feedback by Thursday.',
  },
  {
    channel: 'acme',
    author: 'lena',
    body: 'The depot finder now takes the full width above the fold, like she asked.',
  },
  {
    channel: 'acme',
    author: 'jonas',
    body: 'Staging is up on the German hosting. Emre has the login.',
  },
  {
    channel: 'acme',
    author: 'jonas',
    body: 'Emre wants JSON instead of the nightly CSV for the depots. I am writing the spec today.',
  },
  {
    channel: 'acme',
    author: 'tarek',
    body: 'Careers templates: job list is done, job detail next. Do we have real job ads yet?',
  },
  {
    channel: 'acme',
    author: 'sophie',
    body: 'Nadia is sending four job ads this week. I am interviewing two of the employees on Wednesday.',
  },
  {
    channel: 'acme',
    author: 'mira',
    body: 'Photo shoot: Nadia suggested the Billbrook depot. I am checking dates.',
  },
  {
    channel: 'acme',
    author: 'owner',
    body: 'Holger asked me about the go-live date. I told him the plan says end of next month.',
  },
  { channel: 'acme', author: 'tarek', body: 'Job detail template is on staging now.' },
  {
    channel: 'acme',
    author: 'mira',
    body: 'Pre-launch review with Holger is in the calendar for the week after next.',
  },

  {
    channel: 'design',
    author: 'lena',
    body: 'Elbtal logo route A: wordmark with a harbour crane. Route B: round stamp in kraft. Thoughts before 15:00?',
  },
  {
    channel: 'design',
    author: 'sophie',
    body: 'B works better on the small 250 g bags in my mock-ups.',
  },
  {
    channel: 'design',
    author: 'tarek',
    body: 'A reads better as a favicon. Tested both at 32 px.',
  },
  {
    channel: 'design',
    author: 'lena',
    body: 'Good point, I will show both sizes in the presentation.',
  },
  {
    channel: 'design',
    author: 'lena',
    body: 'Nordlicht high-contrast theme, first pass. Contrast ratios are all above 7:1.',
  },
  {
    channel: 'design',
    author: 'jonas',
    body: 'The tokens can carry it as a third theme, no component changes needed.',
  },
  {
    channel: 'design',
    author: 'sophie',
    body: 'The focus ring disappears on the yellow buttons in high contrast.',
  },
  { channel: 'design', author: 'lena', body: 'Fixed, thanks. New version in the Figma file.' },
  {
    channel: 'design',
    author: 'owner',
    body: 'Museum key visual is on the posters at the U-Bahn now, saw it this morning.',
  },
  {
    channel: 'design',
    author: 'sophie',
    body: 'Icon set for Nordlicht went to Svenja for approval, 64 icons.',
  },

  {
    channel: 'museum',
    author: 'sophie',
    body: 'Dr. Friedrich sent corrections for 6 of the 18 object texts. Final proofreading tomorrow.',
  },
  {
    channel: 'museum',
    author: 'tarek',
    body: 'Audio player with transcripts works on mobile. 4 of the 18 audio files are still missing.',
  },
  {
    channel: 'museum',
    author: 'sophie',
    body: 'The missing audio files come from the museum on Wednesday.',
  },
  {
    channel: 'museum',
    author: 'jonas',
    body: 'I will run the load test on Thursday. The press release goes out on opening day.',
  },
  {
    channel: 'museum',
    author: 'mira',
    body: 'Ole Kaiser confirmed: the press release links to the microsite.',
  },
  {
    channel: 'museum',
    author: 'lena',
    body: 'Social preview images for all 18 objects are exported to Drive.',
  },
  {
    channel: 'museum',
    author: 'tarek',
    body: 'Lighthouse on staging: 98 performance, 100 accessibility.',
  },
  {
    channel: 'museum',
    author: 'sophie',
    body: 'Opening is next week. Go-live the evening before, I will be in the office.',
  },
  {
    channel: 'museum',
    author: 'owner',
    body: 'I will join the opening with the museum board. Anyone else coming?',
  },
  { channel: 'museum', author: 'mira', body: 'Me and Sophie. I will bring the launch checklist.' },
]
