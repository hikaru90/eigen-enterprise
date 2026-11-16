import { z } from 'zod'

/**
 * Renaming a conversation (Contribute 495e40bb). Shared by server and client
 * — no server imports here — so the inline editor and the PATCH endpoint
 * enforce one rule: trimmed, not empty, at most RUN_TITLE_MAX characters.
 */
export const RUN_TITLE_MAX = 120

export const renameRunBody = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'A conversation needs a name.')
    .max(RUN_TITLE_MAX, `A name is at most ${RUN_TITLE_MAX} characters.`),
})

export type RenameRunBody = z.infer<typeof renameRunBody>
