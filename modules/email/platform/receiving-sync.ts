/**
 * The receipt-rule sync as the mailbox pages call it (plan/email-inbox.md S2):
 * null when the rules match the mailboxes, else Amazon's reason in plain words.
 */
export async function syncMailReceiving(): Promise<string | null> {
  const { emailPlatform } = await import('./service')
  return emailPlatform().syncReceiving()
}
