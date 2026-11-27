// Every e2e file imports `test` from here instead of '@playwright/test' (same API). When the
// release gate records (EE_E2E_DEPS=1, scripts/test-cache/README.md), each test asks the dev
// server which repo files ran since the previous ask, before (beforeAll hooks, the gap between
// tests) and after it, and notes them under its file. A file without that record always runs.
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { test as base } from '@playwright/test'

export * from '@playwright/test'

async function record(baseURL: string | undefined, file: string): Promise<void> {
  const out = process.env.EE_E2E_DEPS_OUT
  if (!out || !baseURL)
    throw new Error('e2e deps: EE_E2E_DEPS_OUT and baseURL must be set when EE_E2E_DEPS=1')
  const res = await fetch(`${baseURL}/__e2e-deps/take`, { method: 'POST' })
  if (!res.ok)
    throw new Error(`e2e deps: the dev server answered ${res.status} to /__e2e-deps/take`)
  const { files } = (await res.json()) as { files: string[] }
  // One file per worker (TEST_PARALLEL_INDEX): workers never append to the same file.
  appendFileSync(
    path.join(out, `raw-${process.env.TEST_PARALLEL_INDEX ?? '0'}.jsonl`),
    `${JSON.stringify({ file: path.relative(process.cwd(), file), files })}\n`,
  )
}

export const test = base.extend<{ e2eDeps: void }>({
  e2eDeps: [
    async ({ baseURL }, use, testInfo) => {
      if (process.env.EE_E2E_DEPS !== '1') return use()
      await record(baseURL, testInfo.file)
      await use()
      await record(baseURL, testInfo.file)
    },
    { auto: true },
  ],
})
