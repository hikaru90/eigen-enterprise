/** Realistic per-genre copy for the preview composition (plan/phase-brand-picker.md §3.2). */
export type PreviewCopy = {
  logo: string
  heading: string
  subtitle: string
  links: [string, string, string]
  primary: string
  secondary: string
  badge: string
  cardTitle: string
  input: string
}

const c = (
  logo: string,
  heading: string,
  subtitle: string,
  links: [string, string, string],
  primary: string,
  secondary: string,
  cardTitle: string,
  input: string,
  badge = 'New',
): PreviewCopy => ({ logo, heading, subtitle, links, primary, secondary, badge, cardTitle, input })

export const DEFAULT_COPY: PreviewCopy = c(
  'Harbor',
  'Built for the work you do',
  'Tools and services for growing teams.',
  ['Product', 'About', 'Contact'],
  'Get started',
  'Learn more',
  'Starter plan',
  'Email address',
)

/** Keyed by genre id. Unknown genres fall back to DEFAULT_COPY. */
export const GENRE_COPY: Record<string, PreviewCopy> = {
  'swiss-minimal': c(
    'Grid',
    'Form follows function',
    'A studio for typographic systems.',
    ['Projects', 'Studio', 'Index'],
    'Contact',
    'View work',
    'Exhibition 04',
    'Email address',
  ),
  editorial: c(
    'The Review',
    'The quiet return of print',
    'Long reads, weekly. Curated by editors.',
    ['Latest', 'Essays', 'Culture'],
    'Subscribe',
    'Read',
    'Issue 112',
    'Your email',
  ),
  corporate: c(
    'Northwind',
    'Finance, made accountable',
    'Reporting and controls for modern teams.',
    ['Platform', 'Pricing', 'Customers'],
    'Contact sales',
    'Talk to us',
    'Q3 report',
    'Work email',
  ),
  saas: c(
    'Loopwise',
    'Ship your roadmap faster',
    'Plan, track and release in one place.',
    ['Product', 'Pricing', 'Docs'],
    'Start free',
    'Book demo',
    'Pro plan',
    'you@company.com',
  ),
  brutalist: c(
    'RAW/SITE',
    'NO TEMPLATES. NO MERCY.',
    'Index of things we built by hand.',
    ['WORK', 'TEXT', 'INFO'],
    'JOIN',
    'READ',
    'ZINE #7',
    'EMAIL',
    'NEW',
  ),
  playful: c(
    'Bloop',
    'Make learning wildly fun',
    'Bite-size lessons kids actually love.',
    ['Games', 'Parents', 'Blog'],
    'Try it',
    'Explore',
    'Level 3',
    'Your name',
  ),
  luxury: c(
    'Maison Aurel',
    'Crafted to endure',
    'Fine leather goods since 1924.',
    ['Collections', 'Atelier', 'Stores'],
    'Book',
    'Discover',
    'Limited edition',
    'Email for invitation',
  ),
  retro: c(
    'Rocket Diner',
    'Good times, hot coffee',
    'Open late since the summer of ’62.',
    ['Menu', 'Jukebox', 'Visit'],
    'Order',
    'Our story',
    'Blue plate special',
    'Your email',
  ),
  technical: c(
    'devkit',
    'Deploy in one command',
    'Edge builds, logs and rollbacks for CI.',
    ['Docs', 'CLI', 'Status'],
    'Sign in',
    'Read docs',
    'v2.4.1',
    '$ npm i devkit',
  ),
  organic: c(
    'Field & Fern',
    'Slow coffee, warm bread',
    'A neighbourhood café rooted in season.',
    ['Menu', 'Story', 'Visit'],
    'Order',
    'Our farm',
    'Seasonal',
    'Your email',
  ),
  futuristic: c(
    'NOVA',
    'Interfaces for tomorrow',
    'Spatial computing for creative teams.',
    ['Labs', 'Vision', 'Join'],
    'Launch',
    'Watch',
    'Beta access',
    'Access code',
    'Beta',
  ),
}

export function copyForGenre(genreId: string | null | undefined): PreviewCopy {
  return (genreId && GENRE_COPY[genreId]) || DEFAULT_COPY
}
