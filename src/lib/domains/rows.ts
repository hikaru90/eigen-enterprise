import { MAIL_READY_STATES, type DomainState } from './contract'

/**
 * Plain words for a bought domain that isn't a mail domain (yet), as
 * Settings › Domains shows them under the domain; null when there is nothing
 * to say (a failed purchase shows its own error).
 */
export function mailNote(state: DomainState, mode: 'own' | 'managed' | null): string | null {
  if (state === 'failed') return null
  if (mode === 'own')
    return 'This server sends with your own Amazon SES. To send from this domain, add it under Email › Setup.'
  if (mode === null) return 'Email isn’t set up on this server yet.'
  return state === 'configuring' || MAIL_READY_STATES.includes(state)
    ? 'Becoming a mail domain (within a minute).'
    : null
}
