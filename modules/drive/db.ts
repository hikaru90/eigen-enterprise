import type { AppDatabase } from '$lib/server/db/context'

/** Drive tables carry no RLS: the request-scoped handle when there is one, the pooled app handle otherwise. */
export async function driveDb(): Promise<AppDatabase> {
  const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
  return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
}
