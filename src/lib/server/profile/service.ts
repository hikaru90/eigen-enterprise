import { and, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { userPreference } from '$lib/server/db/schema'
import { avatarUrl, isAvatarSha, isProfileComplete } from '$lib/profile/profile'
import { avatarBlobs } from './avatar'

/**
 * The person's profile (P-5) — one record: "user".first_name / last_name /
 * name ("First Last") / avatar_sha256 / image. user_preference.display_name
 * (what the welcome greets you with, 0083) follows the first name, so the
 * boot sequence says "Hello, Ada." and never asks again.
 */

export type Profile = {
  firstName: string
  lastName: string
  name: string
  email: string
  image: string | null
  avatarSha256: string | null
  complete: boolean
}

export async function getProfile(userId: string): Promise<Profile> {
  const [row] = await authDb
    .select({
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      email: user.email,
      image: user.image,
      avatarSha256: user.avatarSha256,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  if (!row) throw new Error(`no account ${userId}`)
  const avatarSha256 = isAvatarSha(row.avatarSha256) ? row.avatarSha256 : null
  return {
    firstName: row.firstName ?? '',
    lastName: row.lastName ?? '',
    name: row.name,
    email: row.email,
    image: avatarSha256 ? avatarUrl(avatarSha256) : null,
    avatarSha256,
    complete: isProfileComplete(row),
  }
}

/** Writes the names (already validated by normalizeProfileNames). Fails loud on a missing account. */
export async function saveProfileNames(
  userId: string,
  names: { firstName: string; lastName: string; name: string },
): Promise<void> {
  const rows = await authDb
    .update(user)
    .set({ firstName: names.firstName, lastName: names.lastName, name: names.name })
    .where(eq(user.id, userId))
    .returning({ id: user.id })
  if (rows.length !== 1) throw new Error(`profile update for ${userId} matched ${rows.length} rows`)
  await getDb()
    .insert(userPreference)
    .values({ userId, displayName: names.firstName })
    .onConflictDoUpdate({
      target: userPreference.userId,
      set: { displayName: names.firstName, updatedAt: new Date() },
    })
}

/** Stores checked picture bytes and points the account at them. Returns the image route. */
export async function saveAvatar(userId: string, bytes: Uint8Array): Promise<{ image: string; sha256: string }> {
  const { sha256 } = await avatarBlobs().put(bytes)
  const image = avatarUrl(sha256)
  const rows = await authDb
    .update(user)
    .set({ avatarSha256: sha256, image })
    .where(eq(user.id, userId))
    .returning({ id: user.id })
  if (rows.length !== 1) throw new Error(`avatar update for ${userId} matched ${rows.length} rows`)
  return { image, sha256 }
}

/** The bytes of a picture someone currently uses, or null (unknown / replaced pictures are not served). */
export async function readAvatar(sha256: string): Promise<Uint8Array | null> {
  if (!isAvatarSha(sha256)) return null
  const [row] = await authDb
    .select({ id: user.id })
    .from(user)
    .where(and(isNotNull(user.avatarSha256), eq(user.avatarSha256, sha256)))
    .limit(1)
  if (!row) return null
  const blobs = avatarBlobs()
  if (!(await blobs.has(sha256))) {
    throw new Error(`profile picture ${sha256} is referenced by an account but missing on disk`)
  }
  return blobs.get(sha256)
}
