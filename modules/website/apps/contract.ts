import { z } from 'zod'

/**
 * A service's build contract (ee's AppContract, plan/phase-substrate.md §3.3).
 * It comes from the repo's ee.json when there is one; otherwise from the
 * owner's form, which ee stores in the COMPANY repo (the workload's
 * `contract`), never in the app's repo. A runtime the catalog lacks is a
 * catalog gap (D16): an eigen change, not a container.
 */

import type { AppContract, Catalog, RepoContract } from '$lib/server/ee/client'

export type { AppContract, Catalog, RepoContract }

/** A plain sentence for the owner (and for the agent to relay); detail stays in `cause`. */
export class AppUserError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AppUserError'
  }
}

export class CatalogGapUserError extends AppUserError {
  readonly code = 'catalog_gap'
  constructor(
    readonly missing: string[],
    message: string,
  ) {
    super(message)
    this.name = 'CatalogGapUserError'
  }
}

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/
const CMD = z.string().trim().max(400)

export const contractFormSchema = z
  .object({
    runtime: z.enum(['node', 'static']),
    nodeVersion: z
      .string()
      .regex(/^\d{2}$/, 'a Node.js major version, e.g. 22')
      .optional(),
    install: CMD.default(''),
    build: CMD.default(''),
    start: CMD.default(''),
    health: z
      .string()
      .trim()
      .startsWith('/', 'the health path starts with /')
      .max(200)
      .default('/'),
    portEnv: z.string().regex(ENV_KEY, 'a variable name like PORT').optional(),
    staticDir: z
      .string()
      .regex(/^[a-zA-Z0-9._/-]+$/)
      .optional(),
  })
  .strict()

export type ContractForm = z.input<typeof contractFormSchema>

/** Characters that only mean something to a shell; ee runs argv, so they would be passed literally. */
const SHELL_SYNTAX = /[;&|<>`$\\(){}]/

function argv(label: string, raw: string): string[] {
  if (/["']/.test(raw)) {
    throw new AppUserError(
      `The ${label} can't contain quotes: each word is passed to the program as it is.`,
    )
  }
  if (SHELL_SYNTAX.test(raw)) {
    throw new AppUserError(
      `The ${label} is run directly, not through a shell, so it can't use ; & | < > $ or brackets. Use one plain command.`,
    )
  }
  return raw.split(/\s+/).filter(Boolean)
}

/** Why ee could not run this command as argv, in plain words; null when it can. */
export function commandProblem(label: string, raw: string): string | null {
  try {
    argv(label, raw)
    return null
  } catch (err) {
    if (err instanceof AppUserError) return err.message
    throw err
  }
}

export function contractFromForm(input: ContractForm): AppContract {
  const f = contractFormSchema.parse(input)
  const steps: Array<[string, string]> = [
    ['install command', f.install],
    ['build command', f.build],
  ]
  const build = steps.filter(([, c]) => c !== '').map(([label, c]) => argv(label, c))
  if (f.runtime === 'static') {
    if (!f.staticDir)
      throw new AppUserError('A static site needs the folder to serve (for example dist).')
    return {
      runtime: 'static',
      build,
      preStart: [],
      staticDir: f.staticDir,
      health: f.health,
      services: [],
      capabilities: [],
    }
  }
  if (!f.nodeVersion) throw new AppUserError('Pick the Node.js version.')
  if (!f.start)
    throw new AppUserError('A Node.js app needs a start command (for example: node index.js).')
  return {
    runtime: 'node',
    node: f.nodeVersion,
    build,
    start: argv('start command', f.start),
    preStart: [],
    health: f.health,
    ...(f.portEnv ? { portEnv: f.portEnv } : {}),
    services: [],
    capabilities: [],
  }
}

function describeMissing(entry: string): string {
  const node = /^runtime node@(\d+)$/.exec(entry)
  return node ? `Node.js ${node[1]}` : entry
}

export function gapError(missing: string[], catalog: Catalog): CatalogGapUserError {
  const offered = catalog.runtimes.node.map((v) => `Node.js ${v}`).join(', ')
  return new CatalogGapUserError(
    missing,
    `This app needs ${missing.map(describeMissing).join(', ')}, which this server doesn't provide yet ` +
      `(it provides ${offered || 'no Node.js'}, and static sites). Adding it is a change to Eigen itself, not a container — ` +
      'ask for it in the chat, or switch the app to a provided version.',
  )
}

function catalogGaps(c: AppContract, catalog: Catalog): string[] {
  const missing: string[] = []
  if (c.runtime === 'node' && c.node && !catalog.runtimes.node.includes(c.node))
    missing.push(`runtime node@${c.node}`)
  for (const s of c.services) if (!catalog.services.includes(s)) missing.push(`service ${s}`)
  for (const cap of c.capabilities)
    if (!catalog.capabilities.includes(cap)) missing.push(`capability ${cap}`)
  return missing
}

export type ResolvedContract = { source: 'repo' | 'form'; contract: AppContract }

/**
 * ee.json in the repo wins. Without one: the form just submitted, else the
 * app's saved build settings (the last healthy form deploy), else the
 * contract ee still holds, else ask for the form.
 */
export function resolveContract(i: {
  repo: RepoContract
  form: ContractForm | null
  stored: AppContract | null
  catalog: Catalog
}): ResolvedContract {
  if (i.repo.present) {
    if (i.repo.error || !i.repo.contract) {
      throw new AppUserError(
        `The repo's ee.json can't be used: ${i.repo.error ?? 'it is empty'}. Fix it in the repo and deploy again.`,
      )
    }
    if (i.repo.gap && i.repo.gap.length > 0) throw gapError(i.repo.gap, i.catalog)
    return { source: 'repo', contract: i.repo.contract }
  }
  const contract = i.form ? contractFromForm(i.form) : i.stored
  if (!contract) {
    throw new AppUserError(
      'This repo has no ee.json, so Eigen needs to know how to build and start it. Fill in the build form (runtime, install, start, health path).',
    )
  }
  const missing = catalogGaps(contract, i.catalog)
  if (missing.length > 0) throw gapError(missing, i.catalog)
  return { source: 'form', contract }
}

/** The build form's terms for a stored contract (to apply a suggested change and redeploy). */
export function formFromContract(c: AppContract): ContractForm {
  if (c.build.length > 2) {
    throw new AppUserError(
      'This app has more than an install and a build step, so a change has to be made in the build form itself.',
    )
  }
  return {
    runtime: c.runtime,
    ...(c.node ? { nodeVersion: c.node } : {}),
    install: c.build[0]?.join(' ') ?? '',
    build: c.build[1]?.join(' ') ?? '',
    start: c.start?.join(' ') ?? '',
    health: c.health,
    ...(c.portEnv ? { portEnv: c.portEnv } : {}),
    ...(c.staticDir ? { staticDir: c.staticDir } : {}),
  }
}
