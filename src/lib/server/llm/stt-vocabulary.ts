import { desc, eq, or } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { user } from '$lib/server/db/auth.schema'
import { userPreference } from '$lib/server/db/brain.schema'
import { contacts } from '$lib/server/db/contacts.schema'
import { foundingCompanyName } from '$lib/server/overview/sources'

/**
 * The context a transcription is given (Contribute be1ad246: names were misheard): the
 * company's name, the people the speaker is likely to name (members, and the contacts this
 * person may see), and the language this person uses the app in. It goes to the model as its
 * spelling/vocabulary prompt (OpenAI's transcription `prompt`, passed through OpenRouter's
 * provider options): it biases how names are written, it never forces a language — a member
 * may dictate in another language than the UI's, and the model still hears that.
 *
 * Never logged; never stored.
 */

/** OpenAI caps the transcription prompt; well inside it, and short enough not to steer content. */
export const STT_PROMPT_MAX_CHARS = 900
/** Contact names offered (the most recently touched first). */
export const STT_CONTACT_NAME_LIMIT = 60
/** Member names offered. */
export const STT_MEMBER_NAME_LIMIT = 40

export type SttVocabulary = {
  companyName: string | null
  /** ISO-639-1 code of the UI language this person chose; null = not known. */
  uiLanguage: string | null
  /** People and organisations, most relevant first. */
  names: readonly string[]
}

/** English name of an ISO-639-1 code ("de" → "German"), via the runtime's own locale data. */
function languageName(code: string): string | null {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code)
    return name && name !== code ? name : null
  } catch {
    return null
  }
}

/**
 * The prompt text, or null when there is nothing to say. Names are de-duplicated (exact,
 * after trimming) and cut at {@link STT_PROMPT_MAX_CHARS} on a whole name.
 */
export function buildTranscriptionPrompt(vocabulary: SttVocabulary): string | null {
  const lines: string[] = []
  const company = vocabulary.companyName?.trim()
  if (company) lines.push(`Dictation in the workspace of ${company}.`)
  const language = vocabulary.uiLanguage ? languageName(vocabulary.uiLanguage) : null
  if (language) lines.push(`The speaker usually works in ${language}, and may also speak other languages.`)

  const head = lines.join(' ')
  const seen = new Set<string>()
  const names: string[] = []
  let length = head.length + ' Names that may come up: .'.length
  for (const raw of vocabulary.names) {
    const name = raw.trim()
    if (!name || seen.has(name) || name === company) continue
    const added = (names.length === 0 ? 0 : 2) + name.length
    if (length + added > STT_PROMPT_MAX_CHARS) break
    seen.add(name)
    names.push(name)
    length += added
  }
  const text = names.length > 0 ? `${head} Names that may come up: ${names.join(', ')}.`.trim() : head
  return text === '' ? null : text
}

/** Reads the vocabulary for one person: only names this person may see. */
export async function loadSttVocabulary(userId: string): Promise<SttVocabulary> {
  const db = getDb()
  const [companyName, preference, members, contactRows] = await Promise.all([
    foundingCompanyName(),
    db
      .select({ uiLocale: userPreference.preferredUiLocale })
      .from(userPreference)
      .where(eq(userPreference.userId, userId))
      .limit(1),
    db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.accountKind, 'production'))
      .orderBy(desc(user.updatedAt))
      .limit(STT_MEMBER_NAME_LIMIT),
    // the contacts service's own visibility: the person's own contacts and the shared ones
    db
      .select({ name: contacts.name, organisation: contacts.organisation })
      .from(contacts)
      .where(or(eq(contacts.createdBy, userId), eq(contacts.shared, true)))
      .orderBy(desc(contacts.updatedAt))
      .limit(STT_CONTACT_NAME_LIMIT),
  ])
  const uiLocale = preference[0]?.uiLocale?.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return {
    companyName,
    uiLanguage: /^[a-z]{2}$/.test(uiLocale) ? uiLocale : null,
    names: [
      ...members.map((m) => m.name),
      ...contactRows.flatMap((c) => (c.organisation ? [c.name, c.organisation] : [c.name])),
    ],
  }
}

/** The prompt for one person's transcription. */
export async function loadTranscriptionPrompt(userId: string): Promise<string | null> {
  return buildTranscriptionPrompt(await loadSttVocabulary(userId))
}
