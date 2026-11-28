import type { PatternDigest } from './digest'
import type { PatternDeps } from './service'
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { moduleLabel } from '$lib/server/activity/readable-log'
import { appKernel } from '$lib/server/boot'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { coworkerProfile } from '$lib/server/db/coworkers.schema'
import { kernelEvents } from '$lib/server/db/kernel.schema'
import { patternDigest } from '$lib/server/db/patterns.schema'
import { stripMarkdownJsonFences } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'

/**
 * Production wiring of the What's happening digest: the audit trail's changes, the kernel
 * registry as the catalog (a tool's module and permission roles; internal modules such as the
 * kernel's own admin surface are no activity to show), account names, the gateway on the
 * company provider in the owner's session, and the pattern_digest table.
 */
export async function livePatternDeps(): Promise<PatternDeps> {
  const kernel = await appKernel()
  return {
    now: () => new Date(),
    events: async (since) => {
      const rows = await getDb()
        .select({ ts: kernelEvents.ts, principalId: kernelEvents.principalId, tool: sql<string>`${kernelEvents.payload}->>'tool'` })
        .from(kernelEvents)
        .where(
          and(
            eq(kernelEvents.type, 'tool.executed'),
            gte(kernelEvents.ts, since),
            isNotNull(kernelEvents.principalId),
            ne(sql`${kernelEvents.payload}->>'auditClass'`, 'read'),
            eq(sql`${kernelEvents.payload}->>'ok'`, 'true'),
          ),
        )
      return rows.flatMap((r) => (r.principalId && r.tool ? [{ principalId: r.principalId, tool: r.tool, at: r.ts }] : []))
    },
    catalog: (tool) => {
      const descriptor = kernel.registry.get(tool)
      if (!descriptor) return null
      if (kernel.modules.get(descriptor.module)?.internal === true) return null
      return { module: descriptor.module, roles: descriptor.permission.roles }
    },
    personNames: async (ids) => {
      if (ids.length === 0) return new Map()
      const rows = await authDb
        .select({ id: user.id, name: user.name })
        .from(user)
        .leftJoin(coworkerProfile, eq(coworkerProfile.userId, user.id))
        .where(and(inArray(user.id, [...ids]), isNull(coworkerProfile.removedAt)))
      return new Map(rows.filter((r) => r.name?.trim()).map((r) => [r.id, r.name.trim()]))
    },
    moduleLabel,
    write: async (messages) => {
      const [{ llmChatCompletion }, { onCompanyProvider, companyOwnerId }, { withDbUser }] = await Promise.all([
        import('$lib/server/llm/llm-client'),
        import('$lib/server/llm/company-provider'),
        import('$lib/server/db'),
      ])
      const owner = await companyOwnerId()
      if (!owner) throw new Error("What's happening needs the company owner's AI provider; the company has no owner yet")
      const response = await onCompanyProvider(() =>
        withDbUser(owner, () =>
          llmChatCompletion({ userId: owner, messages, temperature: 0, task: 'brain.patterns_digest', responseFormat: 'json_object' }),
        ),
      )
      return stripMarkdownJsonFences(extractChatContent(response))
    },
    latest: async () => {
      const [row] = await getDb().select().from(patternDigest).orderBy(desc(patternDigest.createdAt)).limit(1)
      return row ? (row as PatternDigest) : null
    },
    save: async (digest) => {
      const [row] = await getDb().insert(patternDigest).values(digest).returning()
      return row as PatternDigest
    },
  }
}

/** Whether a module is active, read exactly as the registry's activation gate reads it. */
export async function liveModuleActivity(moduleIds: readonly string[]): Promise<(moduleId: string) => boolean> {
  const kernel = await appKernel()
  const active = new Set<string>()
  for (const id of new Set(moduleIds)) if (await kernel.activations.get(id)) active.add(id)
  return (moduleId) => active.has(moduleId)
}
