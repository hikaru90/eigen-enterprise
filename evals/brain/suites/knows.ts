import type { KnowsItem } from '../types'

/**
 * Knows: questions answerable only from the company's own data, each asked
 * by someone entitled to every source it needs. Graded on a correct answer
 * WITH a source (closed-set judge) — and, without a model, on whether the
 * asker's tools can even reach the sources (their markers).
 *
 * Layer: `happen` when the answer lives in communication a module must
 * report first (mail, calls, DMs, channels); `understand` for documents and
 * records; `initiate` when the brain must notice an open commitment.
 */
export const KNOWS: KnowsItem[] = [
  { suite: 'knows', id: 'K01', layer: 'happen', concept: 'call-transcript', asker: 'martin', prompt: 'What did we agree with Acme in the call?', gold: '$40 per seat per month for 25 seats, a 12-month term, pilot starting January 5; Ony sends the contract by November 28.', sources: ['call-acme'] },
  { suite: 'knows', id: 'K02', layer: 'understand', concept: 'pptx-content', asker: 'jonas', prompt: "What's in our current pitch deck?", gold: 'Pitch deck v3: Fjordlight Studio — AI tooling for small teams (seed round 2026); problem: small teams drown in disconnected tools; traction: 14 paying customers, €18k MRR, Acme pilot in January; ask: €1.2M seed to grow from 4 to 9 people.', sources: ['drive-pitch'] },
  { suite: 'knows', id: 'K03', layer: 'understand', concept: 'pptx-content', asker: 'priya', prompt: 'How much are we raising, according to the deck?', gold: '€1.2M seed, to grow the team from 4 to 9.', sources: ['drive-pitch'] },
  { suite: 'knows', id: 'K04', layer: 'understand', concept: 'pptx-content', asker: 'ony', prompt: 'What traction numbers do we show investors?', gold: '14 paying customers and €18k monthly recurring revenue, plus the Acme pilot starting in January.', sources: ['drive-pitch'] },
  { suite: 'knows', id: 'K05', layer: 'understand', concept: 'shared-doc', asker: 'jonas', prompt: 'What are our brand colours?', gold: 'Primary Fjord Blue #1F4E79 and accent Amber #F2A93B (Inter as the typeface).', sources: ['drive-brand'] },
  { suite: 'knows', id: 'K06', layer: 'understand', concept: 'shared-doc', asker: 'jonas', prompt: 'How many vacation days do we get per year?', gold: '28 days per year.', sources: ['drive-handbook'] },
  { suite: 'knows', id: 'K07', layer: 'understand', concept: 'shared-doc', asker: 'priya', prompt: 'Up to what amount can I spend without approval?', gold: 'Up to €500; above that, ask Ony.', sources: ['drive-handbook'] },
  { suite: 'knows', id: 'K08', layer: 'understand', concept: 'company-profile', asker: 'jonas', prompt: "Who's on the team and what does each person do?", gold: 'Martin Vale (CEO and co-founder), Ony Okafor (Head of Sales and Operations), Priya Raman (Lead Designer), Jonas Berg (Software Engineer).', sources: ['drive-handbook'] },
  { suite: 'knows', id: 'K09', layer: 'understand', concept: 'calendar', asker: 'ony', prompt: 'When is the investor meeting with Northstar?', gold: '{investorMeeting} (Europe/Berlin).', sources: ['ev-investor'] },
  { suite: 'knows', id: 'K10', layer: 'understand', concept: 'calendar', asker: 'jonas', prompt: 'When is the design review for the onboarding flow, and who organised it?', gold: '{designReview}, organised by Priya.', sources: ['ev-design-review'] },
  { suite: 'knows', id: 'K11', layer: 'understand', concept: 'contacts', asker: 'martin', prompt: 'Who is our contact at Acme and what is their role?', gold: 'Dana Whitfield, Head of Operations at Acme (dana@acme.example).', sources: ['ct-dana'] },
  { suite: 'knows', id: 'K12', layer: 'understand', concept: 'contacts', asker: 'ony', prompt: 'Who is Leo Brandt?', gold: 'A Partner at Northstar Ventures who leads our seed round conversation; met through an intro from a portfolio founder.', sources: ['ct-leo'] },
  { suite: 'knows', id: 'K13', layer: 'happen', concept: 'mailbox-audience', asker: 'ony', prompt: "What did Acme's last email to the sales mailbox ask for?", gold: 'Dana wants to move forward at $40 per seat per month for 25 seats with the pilot on January 5 (PO ACME-PO-88213) and asked to meet next week to walk through the contract.', sources: ['mail-acme-1'] },
  { suite: 'knows', id: 'K14', layer: 'happen', concept: 'channel', asker: 'martin', prompt: "What's the status of the Acme portal?", gold: 'Staging deploy is done and the login fix shipped; production rollout is planned after the pilot starts (Jonas, in #general).', sources: ['msg-general-portal'] },
  { suite: 'knows', id: 'K15', layer: 'happen', concept: 'private-channel', asker: 'martin', prompt: 'By when does Acme need internal budget sign-off?', gold: 'By December 10 — if that slips, the pilot start moves too (Ony in #sales).', sources: ['msg-sales-acme'] },
  { suite: 'knows', id: 'K16', layer: 'happen', concept: 'dm-own', asker: 'priya', prompt: 'Did Jonas reply about reviewing my onboarding Figma?', gold: 'Yes — he said he would look at it tomorrow morning.', sources: ['msg-dm-pj-2'] },
  { suite: 'knows', id: 'K17', layer: 'understand', concept: 'acts-as-person', asker: 'martin', prompt: 'What did I note down about the office lease?', gold: 'To renegotiate the Havnegade office lease before March.', sources: ['th-martin-lease'] },
  { suite: 'knows', id: 'K18', layer: 'understand', concept: 'acts-as-person', asker: 'priya', prompt: 'What was my idea for Acme?', gold: 'Offer Acme a two-week design sprint add-on after the pilot.', sources: ['th-priya-sprint'] },
  { suite: 'knows', id: 'K19', layer: 'understand', concept: 'shared-with-some', asker: 'martin', prompt: "What's the lowest per-seat price Ony's Acme proposal allows?", gold: '$36 per seat (the discount floor; the proposal itself is $40).', sources: ['drive-acme-proposal'] },
  { suite: 'knows', id: 'K20', layer: 'initiate', concept: 'commitments', asker: 'ony', prompt: 'What do I still owe Acme?', gold: 'Send the contract by November 28 (promised in the call) and set up the meeting Dana asked for next week to walk through it.', sources: ['call-acme', 'mail-acme-1'] },
  { suite: 'knows', id: 'K21', layer: 'understand', concept: 'cross-source', asker: 'martin', prompt: 'Summarise where we stand with Acme.', gold: 'Agreed $40/seat/month, 25 seats, 12 months, pilot from January 5; Dana asked to meet next week about the contract; Ony sends the contract by November 28; Acme needs budget sign-off by December 10; the Acme portal is on staging with the login fix shipped.', sources: ['call-acme', 'mail-acme-1', 'msg-sales-acme', 'msg-general-portal'] },
  { suite: 'knows', id: 'K22', layer: 'happen', concept: 'call-transcript', asker: 'ony', prompt: 'When was the Acme pricing call and who was in it?', gold: '{acmeCallDay}; Ony, Martin and Dana Whitfield from Acme (as a guest).', sources: ['call-acme'] },
]
