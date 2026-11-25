import type { MaterialLogo } from '../../../../modules/brand/material/document'
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { CompanyDeps } from '$lib/server/company/service'
import { readCompanyLogo } from '$lib/server/company/service'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { MaterialError } from '../../../../modules/brand/material/types'

/**
 * The app-side wiring behind Brand › Material: the company logo (Settings →
 * Company, its own blob namespace) for the export, and the routes' one error
 * shape. The brand module never reaches into the company profile itself.
 */

/** The current company logo's bytes and type; null when none is set. */
export async function companyLogoFrom(deps: Pick<CompanyDeps, 'store' | 'blobs'>): Promise<MaterialLogo | null> {
  const logo = (await deps.store.get())?.logo
  if (!logo) return null
  const read = await readCompanyLogo(logo.sha256, deps)
  if (!read) throw new Error(`company logo ${logo.sha256} is set but could not be read`)
  return read
}

export async function currentCompanyLogo(): Promise<MaterialLogo | null> {
  const { companyStorage } = await import('$lib/server/company/live')
  return companyLogoFrom(companyStorage())
}

const STATUS: Record<MaterialError['code'], number> = { not_found: 404, invalid: 400, unavailable: 503, upstream: 502 }

/**
 * A refusal as the routes answer it: MaterialError → its status with
 * `{ message, error, agent }`; a schema failure → 400 naming the field.
 * Null for anything else — a real failure the route rethrows.
 */
export function materialFailure(attempted: string, err: unknown): Response | null {
  if (err instanceof MaterialError) {
    return json({ message: err.message, ...errorReport(err, { attempted, plain: () => err.message }) }, { status: STATUS[err.code] })
  }
  if (err instanceof z.ZodError) {
    const issue = err.issues[0]
    const field = issue?.path.join('.')
    const sentence = field ? `${field}: ${issue.message}` : (issue?.message ?? 'Invalid input')
    return json(
      { message: sentence, ...refusalReport(sentence, { attempted, cause: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }) },
      { status: 400 },
    )
  }
  return null
}
