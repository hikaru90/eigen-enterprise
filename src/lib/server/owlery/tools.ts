/**
 * Thin tool-runner exports over the Owlery REST wrappers, shaped for kernel
 * tool descriptors (see modules/email/tools.ts). No policy lives here —
 * configuration resolution and fail-loud behavior come from config.ts and the
 * underlying mail.ts / contacts.ts implementations.
 */

import { type OwleryEnv, resolveOwleryContactBookConfig } from './config'
import { createOwleryContact, type CreateOwleryContactInput } from './contacts'
import { sendTransactionalEmail, type SendTransactionalEmailInput } from './mail'

export async function runSendMailTool(
  env: OwleryEnv,
  input: SendTransactionalEmailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ emailId: string | null }> {
  return sendTransactionalEmail(env, input, fetchImpl)
}

export async function runAddContactTool(
  env: OwleryEnv,
  input: CreateOwleryContactInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ contactId: string | null }> {
  return createOwleryContact(env, input, fetchImpl)
}

/**
 * Lists contacts in the onboarding contact book via
 * `GET /api/v1/contactBooks/{contactBookId}/contacts`. contacts.ts only
 * exports creation, so the read side lives here as the equally thin REST
 * counterpart. Throws when the contact book is not configured (fail loud)
 * and returns the parsed Owlery response body verbatim.
 */
export async function runListContactsTool(
  env: OwleryEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const config = resolveOwleryContactBookConfig(env)
  if (!config) {
    throw new Error(
      'Owlery onboarding list is not configured (set OWLERY_API_KEY, OWLERY_BASE_URL, OWLERY_EMAIL_FROM, and OWLERY_CONTACT_BOOK_ID)',
    )
  }

  const url = `${config.baseUrl}/api/v1/contactBooks/${encodeURIComponent(config.contactBookId)}/contacts`
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  })

  const bodyText = await response.text()
  let parsed: unknown = null
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText) as unknown
    } catch {
      parsed = null
    }
  }

  if (!response.ok) {
    const detail =
      (parsed !== null &&
        typeof parsed === 'object' &&
        'message' in parsed &&
        typeof parsed.message === 'string'
        ? parsed.message
        : bodyText.slice(0, 500)) || response.statusText
    throw new Error(`Owlery contact list failed (${response.status}): ${detail}`)
  }

  if (parsed === null) {
    throw new Error(`Owlery contact list returned a non-JSON body (${response.status})`)
  }
  return parsed
}
