import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { errorReport } from '$lib/server/errors/report'
import {
  isParseDateRangeGatewayFailure,
  PARSE_DATE_RANGE_GATEWAY_USER_ERROR,
  parseDateRangePhrase,
} from '$lib/server/memory/parse-date-range'
import { failed, refuse } from '$lib/server/memory/route-errors'
import { getUserPreferredTimezone } from '$lib/server/memory/user-timezone'
import { parseDateRangeRequestSchema } from '$lib/validation/api-bodies'

export const POST: RequestHandler = async (event) => {
  const ctx = { attempted: 'Parsing a typed date range for the timeline filter' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    return refuse(400, 'Invalid JSON body', ctx)
  }

  const parsed = parseDateRangeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return refuse(400, parsed.error.issues[0]?.message ?? 'Invalid body', ctx)
  }

  const timeZone = parsed.data.timeZone ?? (await getUserPreferredTimezone(user.id))
  const nowIso = parsed.data.nowIso ?? new Date().toISOString()

  try {
    const result = await parseDateRangePhrase({
      userId: user.id,
      phrase: parsed.data.phrase,
      nowIso,
      timeZone,
    })
    return json(result)
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('[timeline.parse-date-range] failed', {
      userId: user.id,
      message,
      stack: err instanceof Error ? err.stack : undefined,
    })
    if (isParseDateRangeGatewayFailure(message)) {
      return json(errorReport(err, { ...ctx, plain: () => PARSE_DATE_RANGE_GATEWAY_USER_ERROR }), {
        status: 502,
      })
    }
    return failed(500, err, ctx)
  }
}
