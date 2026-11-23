import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'

const VOICE_FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', 'release-voice.wav')

/** Short spoken clip: "Release smoke voice capture test" (generated via macOS `say`). */
export function readReleaseVoiceFixture(): Buffer {
  return fs.readFileSync(VOICE_FIXTURE_PATH)
}

/** Authenticated POST to `/api/capture/transcribe` using the release voice fixture. */
export async function assertVoiceTranscribeApi(
  page: Page,
  options?: { timeoutMs?: number },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 180_000
  const buffer = readReleaseVoiceFixture()
  let transcript = ''

  await expect
    .poll(
      async () => {
        const res = await page.request.post('/api/capture/transcribe', {
          multipart: {
            audio: {
              name: 'release-voice.wav',
              mimeType: 'audio/wav',
              buffer,
            },
            language: 'en',
          },
        })

        if (!res.ok()) {
          const bodyText = await res.text()
          const transient =
            res.status() === 429 ||
            res.status() === 502 ||
            res.status() === 503 ||
            (res.status() === 500 && /(?:\b429\b|502|503|rate limit)/i.test(bodyText))
          if (transient) {
            return ''
          }
          throw new Error(`transcribe API failed (${res.status()}): ${bodyText}`)
        }

        const body = (await res.json()) as { transcript?: string }
        const text = body.transcript?.trim() ?? ''
        if (!text) {
          throw new Error('transcribe API returned empty transcript')
        }
        transcript = text
        return text
      },
      { timeout: timeoutMs, intervals: [2_000, 5_000, 10_000] },
    )
    .toMatch(/release|voice|smoke|capture|test/i)

  return transcript
}
