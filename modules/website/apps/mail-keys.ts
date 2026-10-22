/** The env name an app reads its sealed mail key from (docs: GET /docs/send-mail.md). */
export const MAIL_KEY_ENV = 'EE_API_KEY'

/**
 * The mail-only API key behind "Allow this app to send email". Minted with
 * "Can send mail" on and MCP off, so the app can send mail and nothing else.
 * The raw key exists once, on the way to ee's sealed store; here only its hash.
 */
export type AppMailKeys = {
  mint(input: { userId: string; name: string }): Promise<{ id: string; raw: string }>
  revoke(id: string): Promise<void>
}

/** Imports the database lazily, like defaultServiceStore: the module loads without DATABASE_URL. */
export function dbAppMailKeys(): AppMailKeys {
  return {
    async mint({ userId, name }) {
      const [{ generateApiKey }, { getDb }, { userApiKey }] = await Promise.all([
        import('$lib/server/api-keys/api-key-utils'),
        import('$lib/server/db'),
        import('$lib/server/db/schema'),
      ])
      const { raw, prefix, hash } = generateApiKey()
      const [row] = await getDb()
        .insert(userApiKey)
        .values({ userId, name, keyPrefix: prefix, keyHash: hash, mailSend: true, mcp: false })
        .returning({ id: userApiKey.id })
      return { id: row.id, raw }
    },
    async revoke(id) {
      const [{ eq }, { getDb }, { userApiKey }] = await Promise.all([
        import('drizzle-orm'),
        import('$lib/server/db'),
        import('$lib/server/db/schema'),
      ])
      await getDb().update(userApiKey).set({ isActive: false }).where(eq(userApiKey.id, id))
    },
  }
}
