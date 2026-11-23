import type { PageDraft } from './page-audience'
import { defineDecisionKind } from '$lib/server/decisions/kind'

/**
 * The website's decision kinds (plan/phase-company-brain.md §5, CB2).
 *
 * `website.page_audience`: public website content or an internal document? A closed set of
 * two, so a Jev question. The current judge is the chat model's JSON verdict (page-audience.ts,
 * the internal-document guard on agent writes); in shadow both run and the chat judge's answer
 * (and its reason) is what the guard acts on. Jev reads the same page the chat judge reads.
 */

export const PAGE_AUDIENCE_STATE_BODY_CHARS = 12_000

export const websitePageAudience = defineDecisionKind<PageDraft, 'public_website' | 'internal_document'>({
  id: 'website.page_audience',
  module: 'website',
  title: 'Public website content or an internal document?',
  instructions:
    'An AI assistant is about to put this content on the company’s PUBLIC website (a private page is only an unpublished draft of a public page). Is it public website content, or an internal document that belongs in Drive or Memory instead? Judge what the content is for and whom it addresses.',
  choices: ['public_website', 'internal_document'],
  criteria: {
    public_website:
      'Meant for visitors — customers, prospects, the press, applicants: home, about, product, pricing, careers, a blog post, public docs or an FAQ for customers, contact, legal pages.',
    internal_document:
      'Meant for the company’s own people or for investors and funders: pitch decks, investor or funding documents (fundraising, grants, cap tables, financials), project descriptions and briefs, plans and roadmaps, meeting notes, strategy, internal processes and handbooks, drafts for internal use.',
  },
  status: 'shadow',
  lowConfidence: 0,
  state: (page) =>
    JSON.stringify({
      slug: page.slug,
      title: page.title,
      kind: page.kind,
      visibility: page.visibility,
      body: page.body.length > PAGE_AUDIENCE_STATE_BODY_CHARS ? `${page.body.slice(0, PAGE_AUDIENCE_STATE_BODY_CHARS)}\n…(truncated)` : page.body,
    }),
  // The log keeps which page and its shape, never its body (it may be an internal document).
  logInput: (page) => ({ slug: page.slug, title: page.title, kind: page.kind, visibility: page.visibility, bodyChars: page.body.length }),
})
