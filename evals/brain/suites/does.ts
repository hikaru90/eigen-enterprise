import type { DoesItem } from '../types'

/**
 * Does: tasks done by chat alone, graded on the state they leave behind (a
 * structural check: which rows exist after the turn) and, where the task
 * writes text, a closed-set judge on that text. Every task is something a
 * member can do in the UI today — whether the brain can is what we measure.
 */
export const DOES: DoesItem[] = [
  { suite: 'does', id: 'D01', layer: 'act', concept: 'calendar-write', asker: 'martin', prompt: 'Put a 30-minute call with Ony in my calendar on Friday at 14:00.', state: { check: 'calendar_event_created', owner: 'martin', attendee: 'ony', dayOfWeek: 5, startLocal: '14:00' } },
  { suite: 'does', id: 'D02', layer: 'act', concept: 'calendar-write', asker: 'martin', prompt: 'Move the Northstar investor meeting to 11:00 the same day.', state: { check: 'calendar_event_moved', eventId: 'ev-investor', startLocal: '11:00' } },
  { suite: 'does', id: 'D03', layer: 'act', concept: 'mail-reply', asker: 'ony', prompt: "Reply to Acme's last mail proposing Tuesday at 10:00 for the contract walkthrough.", state: { check: 'mail_reply_sent', inReplyToMailId: 'mail-acme-1' }, contentCriterion: 'The reply proposes Tuesday (at 10:00) for walking through the contract.' },
  { suite: 'does', id: 'D04', layer: 'act', concept: 'decks', asker: 'martin', prompt: 'Make a pitch deck from our Drive and brand.', state: { check: 'drive_file_created', owner: 'martin', kind: 'pptx' }, contentCriterion: 'The deck uses the company’s real facts from Drive (14 paying customers, €18k MRR, €1.2M seed ask) and its brand (Fjord Blue / Amber, calm voice).' },
  { suite: 'does', id: 'D05', layer: 'act', concept: 'messages-post', asker: 'priya', prompt: 'Post in #general that the new brand colours are live.', state: { check: 'channel_message_posted', channelId: 'ch-general', author: 'priya' }, contentCriterion: 'The message announces that the new brand colours are live.' },
  { suite: 'does', id: 'D06', layer: 'act', concept: 'messages-dm', asker: 'priya', prompt: 'Send Jonas a direct message asking whether he has reviewed the onboarding Figma.', state: { check: 'dm_message_posted', dmId: 'dm-priya-jonas', author: 'priya' }, contentCriterion: 'The message asks Jonas whether he has reviewed the onboarding Figma.' },
  { suite: 'does', id: 'D07', layer: 'act', concept: 'contacts-write', asker: 'ony', prompt: 'Add Mira Sol, Associate at Northstar Ventures (mira@northstar.example), to our contacts.', state: { check: 'contact_created', owner: 'ony', name: 'Mira Sol' } },
  { suite: 'does', id: 'D08', layer: 'act', concept: 'contacts-write', asker: 'ony', prompt: 'Log that I spoke with Dana from Acme today about the contract.', state: { check: 'contact_logged', contactId: 'ct-dana' } },
  { suite: 'does', id: 'D09', layer: 'act', concept: 'tasks', asker: 'martin', prompt: 'Assign Jonas a task: roll the Acme portal login fix out to production.', state: { check: 'task_assigned', assignee: 'jonas' } },
  { suite: 'does', id: 'D10', layer: 'act', concept: 'drive-write', asker: 'ony', prompt: 'Write a one-page summary of the Acme deal terms as a document in Drive.', state: { check: 'drive_file_created', owner: 'ony', kind: 'any' }, contentCriterion: 'The document states the agreed terms: $40 per seat per month, 25 seats, 12-month term, pilot from January 5.' },
  { suite: 'does', id: 'D11', layer: 'act', concept: 'drive-share', asker: 'priya', prompt: 'Share my "Onboarding flow notes" document with Jonas.', state: { check: 'drive_file_shared', fileId: 'drive-priya-onboarding', withMember: 'jonas' } },
  { suite: 'does', id: 'D12', layer: 'act', concept: 'calls', asker: 'martin', prompt: 'Start a call with Ony.', state: { check: 'call_started', startedBy: 'martin', participant: 'ony' } },
  { suite: 'does', id: 'D13', layer: 'act', concept: 'acts-as-person', asker: 'jonas', prompt: 'Remember that I prefer code reviews in the morning.', state: { check: 'thought_captured', owner: 'jonas' } },
]
