import type { Actions, PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { fail, redirect } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { getUserRole, kernelRolesFor } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { teamQuestionDeps } from '$lib/server/memory/team-questions/live'
import {
  listAudience,
  listQuestions,
  listQuestionTags,
  TeamQuestionError,
} from '$lib/server/memory/team-questions/service'

/**
 * Memory › Questions: team questions (Contribute 057cd4d5) — short questions
 * for the whole company or chosen groups and people, with free tags, answered
 * inline. The filters are URL parameters (?for=me, ?status=open|closed|all,
 * ?tag=…). Every form runs the questions.* registry tool as the signed-in
 * person with their own kernel roles: the page is a client of the registry,
 * the same tools the assistant and the CLI use.
 */

function signedIn(locals: App.Locals): string {
  if (!locals.user) throw redirect(302, '/login')
  return locals.user.id
}

const STATUSES = ['open', 'closed', 'all'] as const
type Status = (typeof STATUSES)[number]

export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = signedIn(locals)
  const forMe = url.searchParams.get('for') === 'me'
  const rawStatus = url.searchParams.get('status')
  const status: Status = forMe ? 'open' : (STATUSES.find((s) => s === rawStatus) ?? 'open')
  const tag = url.searchParams.get('tag')?.trim() || null
  const deps = await teamQuestionDeps()
  const [list, tags, audience] = await Promise.all([
    listQuestions(deps, userId, { tag: tag ?? undefined, status, forMe }),
    listQuestionTags(deps, userId),
    listAudience(deps, userId),
  ])
  return { questions: list.questions, tags: tags.tags, audience, filter: { tag, status, forMe } }
}

const text = (form: FormData, key: string): string | undefined => {
  const v = form.get(key)
  return typeof v === 'string' ? v : undefined
}
const strings = (form: FormData, key: string) =>
  form.getAll(key).filter((v): v is string => typeof v === 'string' && v !== '')
const idOf = (form: FormData) => text(form, 'question_id') ?? ''

async function run(
  userId: string,
  questionId: string,
  tool: string,
  input: Record<string, unknown>,
) {
  const attempted = `Running ${tool} from /m/memory/questions`
  const role = await getUserRole(userId)
  if (!role)
    return fail(403, {
      questionId,
      ...refusalReport('Only a member of this company asks and answers team questions.', {
        attempted,
        tool,
        input,
      }),
    })
  try {
    const kernel = await appKernel()
    await kernel.registry.execute(tool, input, {
      principal: { id: userId, kind: 'human', roles: kernelRolesFor(role) },
      requestId: randomUUID(),
    })
    return { questionId, ok: true as const }
  } catch (err) {
    const report = () =>
      errorReport(err, {
        attempted,
        tool,
        input,
        plain: (e) => (e instanceof Error ? e.message : String(e)),
      })
    if (err instanceof TeamQuestionError)
      return fail(
        err.code === 'not_found'
          ? 404
          : err.code === 'conflict'
            ? 409
            : err.code === 'forbidden'
              ? 403
              : err.code === 'brain_failed'
                ? 502
                : 400,
        {
          questionId,
          ...report(),
        },
      )
    if (err instanceof KernelError && err.code === 'invalid_input')
      return fail(400, { questionId, ...report() })
    throw err
  }
}

export const actions: Actions = {
  ask: async ({ locals, request }) => {
    const userId = signedIn(locals)
    const form = await request.formData()
    // The tag field is comma-separated (structural split; the service normalises each tag).
    const tags = (text(form, 'tags') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const chosen = text(form, 'audience') === 'chosen'
    return run(userId, 'new', 'questions.ask', {
      text: text(form, 'text') ?? '',
      ...(tags.length ? { tags } : {}),
      ...(chosen
        ? {
            audience: 'chosen',
            group_ids: strings(form, 'group_ids'),
            person_ids: strings(form, 'person_ids'),
          }
        : { audience: 'company' }),
    })
  },
  answer: async ({ locals, request }) => {
    const form = await request.formData()
    const id = idOf(form)
    return run(signedIn(locals), id, 'questions.answer', {
      question_id: id,
      text: text(form, 'text') ?? '',
    })
  },
  close: async ({ locals, request }) => {
    const id = idOf(await request.formData())
    return run(signedIn(locals), id, 'questions.close', { question_id: id })
  },
}
