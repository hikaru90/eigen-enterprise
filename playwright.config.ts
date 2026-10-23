import path from 'node:path'
import { defineConfig } from '@playwright/test'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true, override: true })

const slowMo = process.env.PW_SLOW_MO ? Number(process.env.PW_SLOW_MO) : undefined
const mockGatewayPort = Number(process.env.MOCK_GATEWAY_PORT ?? 5199)
const mockGatewayUrl = `http://127.0.0.1:${mockGatewayPort}`
/**
 * Browser baseURL must match ORIGIN (localhost) so Better Auth serves /api/auth/* on the
 * host it signs cookies for. Vite binds [::1] only, so the readiness poll uses
 * localhost too (127.0.0.1 never answers).
 */
const browserUrl = 'http://localhost:4173'

/**
 * No dev server (owner decision 2026-10-23): the ee box is the only install.
 * Every e2e run starts its own throwaway harness — Vite in dev mode (the
 * sign-in-code harness routes exist only there, never in a build) plus the mock
 * gateway — and Playwright stops both when the run ends. Nothing is reused.
 */
export default defineConfig({
  webServer: [
    {
      command: 'vite dev --port 4173 --strictPort',
      url: browserUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        ORIGIN: browserUrl,
        // Deterministic wizard fixtures: catalog + OAuth provider stubs are
        // served by scripts/mock-gateway.mjs on the mock gateway port.
        MODELS_DEV_CATALOG_URL: `${mockGatewayUrl}/models.dev.json`,
        OAUTH_GITHUB_BASE_URL: `${mockGatewayUrl}/gh`,
        OAUTH_GITHUB_API_BASE_URL: mockGatewayUrl,
        OAUTH_ANTHROPIC_AUTHORIZE_URL: `${mockGatewayUrl}/claude/authorize`,
        OAUTH_ANTHROPIC_TOKEN_URL: `${mockGatewayUrl}/claude/v1/oauth/token`,
        OAUTH_ANTHROPIC_API_BASE_URL: `${mockGatewayUrl}/claude`,
        OAUTH_OPENAI_AUTH_BASE_URL: `${mockGatewayUrl}/openai`,
        OAUTH_OPENAI_CODEX_BASE_URL: mockGatewayUrl,
        // The orchestrator runs on the durable engine
        // (engine-choice.ts): its SQLite state needs an explicit dir (fails loud otherwise).
        EE_AGENT_STATE_DIR:
          process.env.EE_AGENT_STATE_DIR ?? path.resolve('test-results/ee-agent-state'),
      },
    },
    {
      command: `node scripts/mock-gateway.mjs`,
      env: { ...process.env, MOCK_GATEWAY_PORT: String(mockGatewayPort) },
      url: mockGatewayUrl,
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
  testMatch: '**/*.e2e.{ts,js}',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Serial workers, on purpose: the suites share singletons — the test DB's
  // kernel_journeys admits ONE active row per kind company-wide, and the mock
  // gateway is one process with a global call counter. Concurrent workers
  // fight over both (the documented stale-process / interleaved-response
  // flake class); serial makes the suites deterministic at the cost of wall
  // time.
  workers: 1,
  use: {
    baseURL: browserUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: ['--disable-popup-blocking'],
      ...(slowMo ? { slowMo } : {}),
    },
  },
})
