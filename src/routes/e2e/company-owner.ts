import postgres from 'postgres'

/**
 * The company's AI provider is the owner's (src/lib/server/llm/company-provider.ts):
 * every member's assistant turn runs on it. A spec that connects a provider and then
 * chats must therefore do it AS the owner — otherwise its turns go to whatever owner
 * the shared test DB already has (and that owner's real provider, not the mock gateway).
 *
 * The single-owner index allows one owner: the current owner (if any) steps aside to
 * admin for the test and is put back by the returned `restore`. Workers are serial
 * (playwright.config.ts), so no other spec sees the swap.
 */
export type CompanyOwnerSwap = { restore: () => Promise<void> }

export async function becomeCompanyOwner(email: string): Promise<CompanyOwnerSwap> {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) throw new Error('DATABASE_URL is not set — becomeCompanyOwner edits the test DB')
  const sql = postgres(url, { prepare: false, max: 1 })
  try {
    const previous = await sql.begin(async (tx) => {
      const [prev] = await tx`select id from "user" where role = 'owner'`
      const prevId = (prev?.id as string | undefined) ?? null
      if (prevId) await tx`update "user" set role = 'admin' where id = ${prevId}`
      const [me] = await tx`update "user" set role = 'owner' where email = ${email} returning id`
      if (!me) throw new Error(`could not make ${email} the owner (no such user)`)
      return { prevId, myId: me.id as string }
    })
    return {
      restore: async () => {
        await sql.begin(async (tx) => {
          await tx`update "user" set role = 'member' where id = ${previous.myId}`
          if (previous.prevId) await tx`update "user" set role = 'owner' where id = ${previous.prevId}`
        })
        await sql.end()
      },
    }
  } catch (err) {
    await sql.end()
    throw err
  }
}
