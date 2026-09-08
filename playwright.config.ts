import path from 'node:path'
import { defineConfig } from '@playwright/test'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true, override: true })

const slowMo = process.env.PW_SLOW_MO ? Number(process.env.PW_SLOW_MO) : undefined
const isCi = Boolean(process.env.CI)

/**
 * Port for the dev server playwright launches. Overridable so a worktree checkout can
 * run e2e against its own code while another checkout's dev server occupies 5173
 * (reuseExistingServer would otherwise attach to THAT server and test the wrong build).
 * ORIGIN is pinned to the same origin in the server env below — process env beats .env,
 * so Better Auth signs cookies for the host the browser actually uses.
 */
const e2ePort = Number(process.env.E2E_PORT ?? 5173)

/** webServer readiness poll uses Node fetch — keep 127.0.0.1 because localhost resolves to ::1, which Vite often does not bind. */
const devUrl = `http://127.0.0.1:${e2ePort}`
/** Browser baseURL must match ORIGIN (localhost) so Better Auth serves /api/auth/* (e.g. email verification links) on the same host it signs cookies for. */
const devBrowserUrl = `http://localhost:${e2ePort}`
const previewUrl = 'http://127.0.0.1:4173'
const mockGatewayUrl = 'http://127.0.0.1:5199'

export default defineConfig({
  webServer: isCi
    ? [
        {
          command: 'npm run build && npm run preview',
          url: previewUrl,
          timeout: 300_000,
          reuseExistingServer: false,
        },
        {
          command: 'node scripts/mock-gateway.mjs',
          url: mockGatewayUrl,
          timeout: 30_000,
          reuseExistingServer: true,
        },
      ]
    : [
        {
          url: devUrl,
          command: `vite dev --host --port ${e2ePort}`,
          timeout: 120_000,
          reuseExistingServer: true,
          env: { ...process.env, ORIGIN: devBrowserUrl },
        },
        {
          command: 'node scripts/mock-gateway.mjs',
          url: mockGatewayUrl,
          timeout: 30_000,
          reuseExistingServer: true,
        },
      ],
  testMatch: '**/*.e2e.{ts,js}',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: isCi ? previewUrl : devBrowserUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: ['--disable-popup-blocking'],
      ...(slowMo ? { slowMo } : {}),
    },
  },
})
