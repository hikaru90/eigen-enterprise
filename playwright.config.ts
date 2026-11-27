import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from '@playwright/test'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true, override: true })

const slowMo = process.env.PW_SLOW_MO ? Number(process.env.PW_SLOW_MO) : undefined

/**
 * Parallel e2e: one complete harness stack per worker ("shard"). Every
 * singleton a spec depends on is per shard, so workers never meet:
 * - its own database, cloned by scripts/e2e.sh from a freshly migrated
 *   template (`<E2E_DB_PREFIX>_<i>`; kernel_journeys' one-active-row-per-kind,
 *   the single-owner index and every seeded row stay inside one shard);
 * - its own mock gateway (its call counter), mock hub, mock GitHub and
 *   livekit-server, each on its own ports;
 * - its own Vite dev server (in-process state: job queue, caches, SSE) and
 *   on-disk dirs (agent SQLite, Drive bytes, company data/keys).
 * A worker finds its shard by TEST_PARALLEL_INDEX (0..workers-1, stable across
 * worker restarts): this file is re-loaded in every worker, so the block below
 * points the worker's env (DATABASE_URL, MOCK_*_PORT, dirs) and baseURL at its
 * shard before any spec module reads them. Shard 0 keeps the historic ports.
 *
 * E2E_WORKERS=1 with no E2E_DB_PREFIX is the single-stack mode on DATABASE_URL
 * as before (one spec by hand); more workers need the per-shard databases.
 */
const workers = Number(process.env.E2E_WORKERS ?? 1)
if (!Number.isInteger(workers) || workers < 1)
  throw new Error(
    `playwright.config: E2E_WORKERS must be a positive integer, got "${process.env.E2E_WORKERS}"`,
  )
const dbPrefix = process.env.E2E_DB_PREFIX?.trim() || undefined
if (workers > 1 && !dbPrefix)
  throw new Error(
    'playwright.config: E2E_WORKERS > 1 needs E2E_DB_PREFIX (one cloned database per worker; scripts/e2e.sh creates them)',
  )
const baseDatabaseUrl = process.env.DATABASE_URL?.trim()

type Shard = {
  index: number
  e2ePort: number
  browserUrl: string
  mockGatewayPort: number
  mockHubPort: number
  mockGitHubPort: number
  mockGitHubCodeloadPort: number
  livekitPort: number
  databaseUrl: string | undefined
  dirs: { agentState: string; drive: string; companyData: string; companyKeys: string }
}

function shard(index: number): Shard {
  const single = workers === 1 && !dbPrefix
  const e2ePort = index === 0 ? Number(process.env.E2E_PORT ?? 4173) : 4200 + index
  const mocks = index === 0 ? null : 5300 + index * 4
  let databaseUrl = baseDatabaseUrl
  if (dbPrefix) {
    if (!baseDatabaseUrl)
      throw new Error(
        'playwright.config: DATABASE_URL is not set (the shard databases live on its server)',
      )
    const u = new URL(baseDatabaseUrl)
    u.pathname = `/${dbPrefix}_${index}`
    databaseUrl = u.toString()
  }
  const dir = (name: string, envKey: string) =>
    single
      ? (process.env[envKey] ?? path.resolve(`test-results/${name}`))
      : path.resolve(`test-results/shard-${index}/${name}`)
  return {
    index,
    e2ePort,
    // Browser baseURL must match ORIGIN (localhost) so Better Auth serves /api/auth/* on the
    // host it signs cookies for. Vite binds [::1] only, so the readiness poll uses
    // localhost too (127.0.0.1 never answers).
    browserUrl: `http://localhost:${e2ePort}`,
    mockGatewayPort: mocks === null ? Number(process.env.MOCK_GATEWAY_PORT ?? 5199) : mocks,
    /**
     * Contribute phone-home (plan/contribute-phone-home.md §6 step 5): a mock
     * central board (scripts/mock-hub.ts, contract-checked and
     * signature-verified) the harness app shares proposals with.
     */
    mockHubPort: mocks === null ? Number(process.env.MOCK_HUB_PORT ?? 5198) : mocks + 1,
    /**
     * GitHub repos in Drive (plan/github-drive-full-mirror.md §8 M4): a mock
     * GitHub (scripts/mock-github.ts) with one fixture repo, kindred/shop. Two
     * origins like GitHub's: the REST API and codeload, where the tarball
     * redirect points (the token client follows it to that exact origin only).
     */
    mockGitHubPort: mocks === null ? Number(process.env.MOCK_GITHUB_PORT ?? 5197) : mocks + 2,
    mockGitHubCodeloadPort:
      mocks === null ? Number(process.env.MOCK_GITHUB_CODELOAD_PORT ?? 5196) : mocks + 3,
    livekitPort: index === 0 ? Number(process.env.E2E_LIVEKIT_PORT ?? 7880) : 7900 + index * 20,
    databaseUrl,
    dirs: {
      agentState: dir('ee-agent-state', 'EE_AGENT_STATE_DIR'),
      drive: dir('ee-drive', 'DRIVE_STORAGE_DIR'),
      companyData: dir('ee-company-data', 'COMPANY_DATA_DIR'),
      companyKeys: dir('ee-company-keys', 'COMPANY_KEYS_DIR'),
    },
  }
}
const shards = Array.from({ length: workers }, (_, i) => shard(i))
// For global-setup.ts (runs in this, the main, process after the web servers are up).
process.env.E2E_SHARDS = JSON.stringify(
  shards.map((s) => ({
    baseURL: s.browserUrl,
    gatewayUrl: `http://127.0.0.1:${s.mockGatewayPort}/v1`,
  })),
)

// In a worker: point the specs (module-level process.env reads) at this worker's shard.
const workerIndex = process.env.TEST_PARALLEL_INDEX
const mine = workerIndex === undefined ? shards[0] : shards[Number(workerIndex)]
if (!mine)
  throw new Error(
    `playwright.config: no shard for TEST_PARALLEL_INDEX=${workerIndex} (${workers} shards)`,
  )
if (workerIndex !== undefined) {
  const shardEnv: Record<string, string> = {
    ...(mine.databaseUrl ? { DATABASE_URL: mine.databaseUrl } : {}),
    MOCK_GATEWAY_PORT: String(mine.mockGatewayPort),
    MOCK_HUB_PORT: String(mine.mockHubPort),
    MOCK_GITHUB_PORT: String(mine.mockGitHubPort),
    MOCK_GITHUB_CODELOAD_PORT: String(mine.mockGitHubCodeloadPort),
    EE_AGENT_STATE_DIR: mine.dirs.agentState,
    DRIVE_STORAGE_DIR: mine.dirs.drive,
    COMPANY_DATA_DIR: mine.dirs.companyData,
    COMPANY_KEYS_DIR: mine.dirs.companyKeys,
  }
  Object.assign(process.env, shardEnv)
  // A helper that re-loads .env with override (release-helpers.ts) re-applies this after.
  process.env.E2E_SHARD_ENV = JSON.stringify(shardEnv)
}

/**
 * Calls (plan/video-calls.md S4): every shard also starts a throwaway
 * livekit-server — the same version ee pins (scripts/release.sh
 * LIVEKIT_VERSION) — with fixed throwaway keys, signalling on loopback and
 * media on loopback only. Its webhook goes to the shard's Vite harness by `localhost`
 * (Vite binds [::1] only; LiveKit's Go resolver tries ::1 too). A missing or
 * different binary fails the whole run here, loudly — never a skip.
 */
const livekitVersion = /^LIVEKIT_VERSION=(\S+)$/m.exec(
  readFileSync(path.resolve('scripts/release.sh'), 'utf8'),
)?.[1]
if (!livekitVersion)
  throw new Error('playwright.config: LIVEKIT_VERSION not found in scripts/release.sh')
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
    throw new Error(
      `${livekitBinary} could not run (${err instanceof Error ? err.message : String(err)}). ${howTo}`,
      { cause: err },
    )
  }
  const found = /version\s+(\S+)/.exec(out)?.[1]
  if (found !== livekitVersion)
    throw new Error(
      `${livekitBinary} is version ${found ?? `unknown ("${out.trim()}")`}, not ${livekitVersion}. ${howTo}`,
    )
}
assertLivekitInstalled()
/** Throwaway, test-only: this harness's own key pair (LiveKit wants a secret of 32+ characters). */
const livekitKey = 'e2e-livekit-key'
const livekitSecret = 'e2e-livekit-throwaway-secret-0123456789abcdef'
function livekitEnvFor(sh: Shard) {
  return {
    LIVEKIT_URL: `ws://127.0.0.1:${sh.livekitPort}`,
    LIVEKIT_API_URL: `http://127.0.0.1:${sh.livekitPort}`,
    LIVEKIT_API_KEY: livekitKey,
    LIVEKIT_API_SECRET: livekitSecret,
  }
}

/**
 * No dev server (owner decision 2026-10-23): the ee box is the only install.
 * Every e2e run starts its own throwaway harness — per shard, Vite in dev mode
 * (the sign-in-code harness routes exist only there, never in a build) plus the
 * mocks and livekit — and Playwright stops them all when the run ends. Nothing is reused.
 */
function shardServers(sh: Shard) {
  const mockGatewayUrl = `http://127.0.0.1:${sh.mockGatewayPort}`
  const mockHubUrl = `http://127.0.0.1:${sh.mockHubPort}`
  const mockGitHubUrl = `http://127.0.0.1:${sh.mockGitHubPort}`
  const mockGitHubCodeloadUrl = `http://127.0.0.1:${sh.mockGitHubCodeloadPort}`
  const livekitEnv = livekitEnvFor(sh)
  const livekitRtcPort = sh.livekitPort + 11 // shard 0: 7891/tcp + 7892/udp: never the box's published 7881/7882
  const livekitConfig = JSON.stringify({
    port: sh.livekitPort,
    bind_addresses: ['127.0.0.1'],
    rtc: {
      tcp_port: livekitRtcPort,
      udp_port: livekitRtcPort + 1,
      node_ip: '127.0.0.1',
      use_external_ip: false,
    },
    keys: { [livekitKey]: livekitSecret },
    webhook: { api_key: livekitKey, urls: [`${sh.browserUrl}/api/calls/livekit`] },
    logging: { level: 'info' },
  })
  return [
    {
      name: `vite-${sh.index}`,
      command: `vite dev --port ${sh.e2ePort} --strictPort`,
      url: sh.browserUrl,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        ...(sh.databaseUrl ? { DATABASE_URL: sh.databaseUrl } : {}),
        ORIGIN: sh.browserUrl,
        // Deterministic wizard fixtures: catalog + OAuth provider stubs are
        // served by scripts/mock-gateway.mjs on the shard's mock gateway port.
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
        // E1: every mail goes to the database-backed fake (read via
        // /api/e2e/harness/mail) — the harness never talks to Amazon SES.
        MAIL_TRANSPORT: 'fake',
        // The orchestrator runs on the durable engine
        // (engine-choice.ts): its SQLite state needs an explicit dir (fails loud otherwise).
        EE_AGENT_STATE_DIR: sh.dirs.agentState,
        // Drive (D1) stores file bytes on disk: a throwaway dir per shard (fails loud when unset).
        DRIVE_STORAGE_DIR: sh.dirs.drive,
        COMPANY_DATA_DIR: sh.dirs.companyData,
        // Contribute sharing: the install's sealed signing key lives beside the company root key.
        COMPANY_KEYS_DIR: sh.dirs.companyKeys,
        // ...and it sends to the shard's mock central board (never the real one).
        CONTRIBUTE_HUB_URL: mockHubUrl,
        // The repos plugin's fine-grained-token client reads the shard's mock GitHub.
        GITHUB_TOKEN_API_BASE_URL: mockGitHubUrl,
        GITHUB_CODELOAD_BASE_URL: mockGitHubCodeloadUrl,
        // Secrets sealed during a run (provider keys, SES keys) need the tenant
        // master key; a throwaway harness gets a throwaway key when .env has none
        // (an unset key crashes the server on the first provider save).
        TENANT_MASTER_KEY: process.env.TENANT_MASTER_KEY || 'e2e-throwaway-tenant-master-key',
        // Calls: the shard's throwaway livekit-server (the console reads these at use time).
        ...livekitEnv,
      },
    },
    {
      name: `livekit-${sh.index}`,
      // LiveKit reads YAML; JSON is YAML. Signalling answers GET / with "OK".
      command: livekitBinary,
      env: { ...process.env, LIVEKIT_CONFIG: livekitConfig },
      url: `${livekitEnv.LIVEKIT_API_URL}/`,
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      name: `mock-gateway-${sh.index}`,
      command: `node scripts/mock-gateway.mjs`,
      env: { ...process.env, MOCK_GATEWAY_PORT: String(sh.mockGatewayPort) },
      url: mockGatewayUrl,
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      name: `mock-hub-${sh.index}`,
      command: `tsx scripts/mock-hub.ts`,
      env: { ...process.env, MOCK_HUB_PORT: String(sh.mockHubPort) },
      url: `${mockHubUrl}/__mock-hub/requests`,
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      name: `mock-github-${sh.index}`,
      command: `tsx scripts/mock-github.ts`,
      env: {
        ...process.env,
        MOCK_GITHUB_PORT: String(sh.mockGitHubPort),
        MOCK_GITHUB_CODELOAD_PORT: String(sh.mockGitHubCodeloadPort),
      },
      url: `${mockGitHubUrl}/__mock-github/health`,
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ]
}

export default defineConfig({
  webServer: shards.flatMap(shardServers),
  // Each shard's company gets its owner before any spec runs (fresh DB per shard).
  globalSetup: './src/routes/e2e/global-setup.ts',
  testMatch: '**/*.e2e.{ts,js}',
  // The release smoke (@release) runs against a real AI provider and its own .env
  // (release-helpers.ts preflight); it has its own script, npm run test:e2e:release:headed.
  // The default run (mock gateway) leaves it out instead of failing its preflight every time.
  grepInvert: process.env.PW_RELEASE === '1' ? undefined : /@release/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One worker per shard (see the shard block above): workers share nothing,
  // so a spec file runs alone on its worker's stack. Files are the unit of
  // distribution (not fullyParallel): tests inside a file keep running in order.
  workers,
  use: {
    baseURL: mine.browserUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: ['--disable-popup-blocking'],
      ...(slowMo ? { slowMo } : {}),
    },
  },
})
