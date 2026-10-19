import { z } from 'zod'

/**
 * The contract (plan/phase-substrate.md §3.2–3.3, D6, D14, D16).
 *
 * Two documents, deliberately separate:
 * - `Workload` lives in the company repo: WHERE it runs, WHICH revision, WITH WHAT.
 * - `AppContract` (`ee.json`) travels with the code: HOW to build and run it, and
 *   what it needs from the catalog.
 *
 * Neither schema has a field that could weaken the sandbox (§3.5): no user,
 * no capabilities, no host paths, no ports, no privileged mode. Unknown keys
 * are rejected (`strict`), so nothing can be smuggled in.
 */

export const NAME = /^[a-z][a-z0-9-]{1,30}$/
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/
const SHA256 = /^[0-9a-f]{64}$/
const GIT_REV = /^[0-9a-f]{40}$/
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** Environment keys ee itself owns; a spec may not set them. */
export const RESERVED_ENV = ['PORT', 'HOST', 'NODE_ENV', 'EE_WORKLOAD', 'EE_STATE_DIR'] as const

const envRecord = z
  .record(z.string().regex(ENV_KEY), z.string().max(4096))
  .refine((env) => !Object.keys(env).some((k) => (RESERVED_ENV as readonly string[]).includes(k)), {
    message: `env may not set reserved keys: ${RESERVED_ENV.join(', ')}`,
  })

export const releaseSource = z
  .object({
    kind: z.literal('release'),
    /** Absolute path to a release tarball on the box (installed or downloaded by ee). */
    tarball: z.string().startsWith('/'),
    sha256: z.string().regex(SHA256),
  })
  .strict()

export const gitSource = z
  .object({
    kind: z.literal('git'),
    /** Local bare mirror under the company repo's sources/ (ee reads only local git, D12). */
    mirror: z.string().regex(/^sources\/[a-z0-9][a-z0-9._-]*\.git$/),
    ref: z.string().min(1).max(200),
    /** Pinned commit. Every deploy pins one, so every deploy is a commit (D4). */
    rev: z.string().regex(GIT_REV),
  })
  .strict()

export const workloadSchema = z
  .object({
    name: z.string().regex(NAME),
    tier: z.enum(['system', 'module', 'app']),
    source: z.discriminatedUnion('kind', [releaseSource, gitSource]),
    env: envRecord.default({}),
    /** Secret NAMES only; values live in ee's encrypted store (D9). */
    secrets: z.array(z.string().regex(ENV_KEY)).default([]),
    resources: z
      .object({
        memoryMb: z.number().int().min(64).max(65536),
        cpuPercent: z.number().int().min(10).max(800),
      })
      .strict()
      .default({ memoryMb: 512, cpuPercent: 100 }),
    deploy: z.object({ auto: z.boolean() }).strict().default({ auto: false }),
  })
  .strict()

export type Workload = z.infer<typeof workloadSchema>
export type WorkloadInput = z.input<typeof workloadSchema>

/** argv, never a shell string: nothing is ever interpreted by a shell. */
const argv = z.array(z.string().min(1).max(1024)).min(1).max(64)

export const appContractSchema = z
  .object({
    runtime: z.enum(['node', 'static']),
    /** Major version for the node runtime. */
    node: z.string().regex(/^\d{2}$/).optional(),
    /** Build steps, each an argv run with the runtime on PATH, inside the release dir. */
    build: z.array(argv).max(16).default([]),
    /** node: the start argv (e.g. ["node", "build/index.js"]). */
    start: argv.optional(),
    /** Steps run before each start (e.g. migrations), as argv. */
    preStart: z.array(argv).max(16).default([]),
    /** static: directory (relative to the release) Caddy serves. */
    staticDir: z.string().regex(/^[a-zA-Z0-9._/-]+$/).optional(),
    health: z.string().startsWith('/').default('/'),
    services: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.runtime === 'node' && !c.start) {
      ctx.addIssue({ code: 'custom', message: 'runtime "node" requires "start"' })
    }
    if (c.runtime === 'node' && !c.node) {
      ctx.addIssue({ code: 'custom', message: 'runtime "node" requires "node" (major version)' })
    }
    if (c.runtime === 'static' && !c.staticDir) {
      ctx.addIssue({ code: 'custom', message: 'runtime "static" requires "staticDir"' })
    }
  })

export type AppContract = z.infer<typeof appContractSchema>

export const routeSchema = z
  .object({
    host: z.string().regex(HOSTNAME),
    workload: z.string().regex(NAME),
    /**
     * Optional path allowlist (Caddy path matchers, e.g. "/s/*"). When set, every
     * other path on this host is a 404 at the edge — used to give eigenEnterprise's
     * public host only its public surface (§3.7).
     */
    allowPaths: z.array(z.string().startsWith('/')).optional(),
    /** Optional rewrite of "/" (e.g. to the website home page). */
    rootRewrite: z.string().startsWith('/').optional(),
  })
  .strict()

export const routesSchema = z.array(routeSchema).superRefine((routes, ctx) => {
  const seen = new Set<string>()
  for (const r of routes) {
    if (seen.has(r.host)) ctx.addIssue({ code: 'custom', message: `duplicate host: ${r.host}` })
    seen.add(r.host)
  }
})

export type Route = z.infer<typeof routeSchema>

/**
 * The catalog (§3.3): the ONLY environment an app runs in. What it declares
 * and the catalog lacks is a gap, and a gap is an eigen change (D16).
 */
export const CATALOG = {
  runtimes: { node: ["22"] as string[], static: [] as string[] },
  services: ['postgres', 'kernel', 'files'],
  capabilities: [] as string[],
} as const

export class CatalogGapError extends Error {
  readonly code = 'catalog_gap'
  constructor(readonly missing: string[]) {
    super(
      `catalog_gap: eigen doesn't provide ${missing.join(', ')}. ` +
        'Apps run only on the catalog; this gap is eigen work (plan/phase-substrate.md D16).',
    )
  }
}

/** Throws CatalogGapError naming every entry the catalog lacks. */
export function assertInCatalog(contract: AppContract): void {
  const missing: string[] = []
  if (contract.runtime === 'node' && contract.node && !CATALOG.runtimes.node.includes(contract.node)) {
    missing.push(`runtime node@${contract.node}`)
  }
  for (const s of contract.services) {
    if (!(CATALOG.services as readonly string[]).includes(s)) missing.push(`service ${s}`)
  }
  for (const c of contract.capabilities) {
    if (!(CATALOG.capabilities as readonly string[]).includes(c)) missing.push(`capability ${c}`)
  }
  if (missing.length > 0) throw new CatalogGapError(missing)
}
