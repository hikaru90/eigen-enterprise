import type { ContributionArea, ContributionKind } from './types'

/**
 * The board's ontology: the closed catalog the LLM judge picks kind and area
 * from (Eigen's board catalog, with eigenEnterprise's areas). Keys are the DB
 * check-constraint values; definitions are what the judge reads.
 */
export const KIND_CATALOG: Readonly<Record<ContributionKind, string>> = {
  idea: 'A new capability or behaviour the person wants the app to have.',
  bug: 'Something that exists but is broken, wrong, lost or crashes — it does not work as intended.',
  polish: 'Something that works but feels rough: layout, wording, readability, small friction, look and feel.',
}

export const AREA_CATALOG: Readonly<Record<ContributionArea, string>> = {
  dashboard: 'Dashboard — the home page at / with "Needs you", the modules and recent activity.',
  assistant: 'Assistant — the AI assistant: the "Ask the assistant" top bar, its chat panel, history and activity.',
  messages: 'Messages — the team chat: channels, direct messages, threads, reactions, notifications.',
  website: 'Website — the public site, its pages, hosting, apps, domains and GitHub deploys.',
  email: 'Email — company email: domains, senders, templates, contacts, flows, sending logs.',
  brand: 'Brand — the company brand: guidelines, visual style, colours and fonts.',
  memory: 'Memory — notes, tasks, projects, the roadmap and capturing thoughts.',
  drive: 'Drive — the company files and folders.',
  settings: 'Settings — account, profile, members and roles, API keys, the AI provider, backups.',
  contribute: 'Contribute — this board itself: proposing improvements and voting.',
  everywhere: 'Everywhere — the whole app or several surfaces at once (navigation, look, speed, sign-in).',
}
