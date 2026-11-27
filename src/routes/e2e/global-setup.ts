import { chromium, expect } from '@playwright/test'
import { registerUser } from './test-helpers'

/**
 * Every shard (playwright.config.ts) starts on a fresh database, and the first account a
 * fresh company gets is its owner (auth owner policy). Specs register users and then set
 * their role (member/admin) or swap the owner and put the previous one back, so a spec's
 * own first user must never be the company's only owner: that is what the long-lived
 * shared test DB used to provide by accident. Here each shard gets its owner explicitly,
 * through the same sign-up path the specs use, before any spec runs — and that owner's AI
 * provider is the shard's mock gateway (the company provider is the owner's,
 * src/lib/server/llm/company-provider.ts), as the shared DB's long-lived owner had.
 */
export default async function globalSetup(): Promise<void> {
  const shards = JSON.parse(process.env.E2E_SHARDS ?? 'null') as
    { baseURL: string; gatewayUrl: string }[] | null
  if (!shards?.length)
    throw new Error('global-setup: E2E_SHARDS is not set (playwright.config.ts sets it)')
  const browser = await chromium.launch()
  try {
    await Promise.all(
      shards.map(async ({ baseURL, gatewayUrl }) => {
        const context = await browser.newContext({ baseURL })
        const page = await context.newPage()
        await registerUser(context, page)
        const saved = await page.request.post('/api/onboarding/provider', {
          data: {
            provider: 'openrouter',
            baseUrl: gatewayUrl,
            apiKey: 'e2e-harness-owner-key',
            modelChat: 'mock-chat-model',
            modelEmbedding: 'mock-embed-model',
          },
        })
        expect(saved.status(), `${baseURL}: connecting the owner's provider`).toBe(200)
        await context.close()
      }),
    )
  } finally {
    await browser.close()
  }
}
