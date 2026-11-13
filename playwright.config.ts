import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from '@playwright/test'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true, override: true })

const slowMo = process.env.PW_SLOW_MO ? Number(process.env.PW_SLOW_MO) : undefined
const mockGatewayPort = Number(process.env.MOCK_GATEWAY_PORT ?? 5199)
const mockGatewayUrl = `http://127.0.0.1:${mockGatewayPort}`
/**
 * Contribute phone-home (plan/contribute-phone-home.md §6 step 5): a mock
 * central board (scripts/mock-hub.ts, contract-checked and
 * signature-verified) the harness app shares proposals with.
 */
const mockHubPort = Number(process.env.MOCK_HUB_PORT ?? 5198)
const mockHubUrl = `http://127.0.0.1:${mockHubPort}`
/**
 * Browser baseURL must match ORIGIN (localhost) so Better Auth serves /api/auth/* on the
 * host it signs cookies for. Vite binds [::1] only, so the readiness poll uses
 * localhost too (127.0.0.1 never answers).
 */
const e2ePort = Number(process.env.E2E_PORT ?? 4173)
const browserUrl = `http://localhost:${e2ePort}`

/**
 * Calls (plan/video-calls.md S4): every run also starts a throwaway
 * livekit-server — the same version ee pins (scripts/release.sh
 * LIVEKIT_VERSION) — with fixed throwaway keys, signalling on loopback and
 * media on loopback only. Its webhook goes to the Vite harness by `localhost`
 * (Vite binds [::1] only; LiveKit's Go resolver tries ::1 too). A missing or
 * different binary fails the whole run here, loudly — never a skip.
 */
const livekitPort = Number(process.env.E2E_LIVEKIT_PORT ?? 7880)
const livekitRtcPort = livekitPort + 11 // 7891/tcp + 7892/udp: never the box's published 7881/7882
const livekitVersion = /^LIVEKIT_VERSION=(\S+)$/m.exec(readFileSync(path.resolve('scripts/release.sh'), 'utf8'))?.[1]
if (!livekitVersion) throw new Error('playwright.config: LIVEKIT_VERSION not found in scripts/release.sh')
const livekitBinary = process.env.E2E_LIVEKIT_BIN ?? 'livekit-server'
function assertLivekitInstalled(): void {
  const howTo =
    `The e2e harness runs livekit-server ${livekitVersion} (the version ee pins in scripts/release.sh). ` +
    `Install it: \`brew install livekit\` (check \`livekit-server --version\`), or download ` +
    `https://github.com/livekit/livekit/releases/tag/v${livekitVersion} and put livekit-server on PATH ` +
    `(or point E2E_LIVEKIT_BIN at it).`
  let out: string
  try {
    out = execFileSync(livekitBinary, ['--version'], { encoding: 'utf8' })
  } catch (err) {
    throw new Error(`${livekitBinary} could not run (${err instanceof Error ? err.message : String(err)}). ${howTo}`, { cause: err })
  }
  const found = /version\s+(\S+)/.exec(out)?.[1]
  if (found !== livekitVersion) throw new Error(`${livekitBinary} is version ${found ?? `unknown ("${out.trim()}")`}, not ${livekitVersion}. ${howTo}`)
}
assertLivekitInstalled()
/** Throwaway, test-only: this harness's own key pair (LiveKit wants a secret of 32+ characters). */
const livekitKey = 'e2e-livekit-key'
const livekitSecret = 'e2e-livekit-throwaway-secret-0123456789abcdef'
const livekitEnv = {
  LIVEKIT_URL: `ws://127.0.0.1:${livekitPort}`,
  LIVEKIT_API_URL: `http://127.0.0.1:${livekitPort}`,
  LIVEKIT_API_KEY: livekitKey,
  LIVEKIT_API_SECRET: livekitSecret,
}
const livekitConfig = JSON.stringify({
  port: livekitPort,
  bind_addresses: ['127.0.0.1'],
  rtc: {
    tcp_port: livekitRtcPort,
    udp_port: livekitRtcPort + 1,
    node_ip: '127.0.0.1',
    use_external_ip: false,
  },
  keys: { [livekitKey]: livekitSecret },
  webhook: { api_key: livekitKey, urls: [`${browserUrl}/api/calls/livekit`] },
  logging: { level: 'info' },
})

/**
 * No dev server (owner decision 2026-10-23): the ee box is the only install.
 * Every e2e run starts its own throwaway harness — Vite in dev mode (the
 * sign-in-code harness routes exist only there, never in a build) plus the mock
 * gateway — and Playwright stops both when the run ends. Nothing is reused.
 */
export default defineConfig({
  webServer: [
    {
      command: `vite dev --port ${e2ePort} --strictPort`,
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
        // The brand picker serves its small test fixture (2 genres × 2 styles ×
        // 2 variants), not the renderer-built index (modules/brand/taxonomy/load-index.ts).
        BRAND_PICKER_INDEX: 'fixture',
        // The orchestrator runs on the durable engine
        // (engine-choice.ts): its SQLite state needs an explicit dir (fails loud otherwise).
        // E1: every mail goes to the database-backed fake (read via
        // /api/e2e/harness/mail) — the harness never talks to Amazon SES.
        MAIL_TRANSPORT: 'fake',
        EE_AGENT_STATE_DIR:
          process.env.EE_AGENT_STATE_DIR ?? path.resolve('test-results/ee-agent-state'),
        // Drive (D1) stores file bytes on disk: a throwaway dir per harness (fails loud when unset).
        DRIVE_STORAGE_DIR: process.env.DRIVE_STORAGE_DIR ?? path.resolve('test-results/ee-drive'),
        COMPANY_DATA_DIR: process.env.COMPANY_DATA_DIR ?? path.resolve('test-results/ee-company-data'),
        // Contribute sharing: the install's sealed signing key lives beside the company root key.
        COMPANY_KEYS_DIR: process.env.COMPANY_KEYS_DIR ?? path.resolve('test-results/ee-company-keys'),
        // ...and it sends to the mock central board below (never the real one).
        CONTRIBUTE_HUB_URL: mockHubUrl,
        // Secrets sealed during a run (provider keys, SES keys) need the tenant
        // master key; a throwaway harness gets a throwaway key when .env has none
        // (an unset key crashes the server on the first provider save).
        TENANT_MASTER_KEY: process.env.TENANT_MASTER_KEY || 'e2e-throwaway-tenant-master-key',
        // Calls: the throwaway livekit-server below (the console reads these at use time).
        ...livekitEnv,
      },
    },
    {
      // LiveKit reads YAML; JSON is YAML. Signalling answers GET / with "OK".
      command: livekitBinary,
      env: { ...process.env, LIVEKIT_CONFIG: livekitConfig },
      url: `${livekitEnv.LIVEKIT_API_URL}/`,
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      command: `node scripts/mock-gateway.mjs`,
      env: { ...process.env, MOCK_GATEWAY_PORT: String(mockGatewayPort) },
      url: mockGatewayUrl,
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      command: `tsx scripts/mock-hub.ts`,
      env: { ...process.env, MOCK_HUB_PORT: String(mockHubPort) },
      url: `${mockHubUrl}/__mock-hub/requests`,
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
