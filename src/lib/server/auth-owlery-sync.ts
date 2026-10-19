export type OwlerySyncUser = {
  id: string
  email?: string | null
  emailVerified?: boolean | null
  firstName?: string | null
  lastName?: string | null
}

/**
 * Mailing-list contact sync after the user's email is confirmed (double opt-in).
 *
 * The Owlery email module sends through Amazon SES, which has no contact book,
 * so there is nothing to sync yet. This stays an explicit, logged no-op until a
 * contact book exists — never a silent one.
 */
export async function syncOwleryContactForVerifiedUser(user: OwlerySyncUser): Promise<void> {
  if (!user.emailVerified || !user.email?.trim()) return
  console.info('[auth] contact-book sync skipped: the email module has no contact book yet', { userId: user.id })
}
