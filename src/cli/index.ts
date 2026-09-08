import type { WiredKernel } from '../../modules/index'
import type { CommandOutcome } from './commands'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { bootstrapKernel } from '../../modules/index'
import { CliArgsError, parseCliArgs } from './args'
import { dispatchCommand, renderOutcome, validateParsedCommand } from './commands'
import { CliPrincipalError, principalFlagValue, resolveCliPrincipal } from './principal'

/**
 * ee — the eigenEnterprise CLI. A thin dispatcher over the kernel registry:
 * admin operations included, everything flows through the same permissioned,
 * approved, audited execute path as the MCP server and the web UI. The CLI
 * has no special powers.
 */

export type CliDeps = {
  /** Kernel factory; defaults to the process-wide bootstrapKernel() singleton. */
  buildKernel?: () => WiredKernel
  /** Environment for EE_CLI_PRINCIPAL_ID resolution; defaults to process.env. */
  env?: Record<string, string | undefined>
}

export type CliRunResult = {
  exitCode: 0 | 1 | 3
  stdout: string
  stderr: string
}

/**
 * Full CLI pipeline without process IO: argv in, rendered output + exit code
 * out. Exit codes: 0 ok, 1 error, 3 approval_required.
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<CliRunResult> {
  let args
  try {
    args = parseCliArgs(argv)
    validateParsedCommand(args)
  } catch (err) {
    if (err instanceof CliArgsError) return { exitCode: 1, stdout: '', stderr: err.message }
    throw err
  }

  const kernel = deps.buildKernel ? deps.buildKernel() : bootstrapKernel()
  await registerAdminTools(kernel)

  let principal
  try {
    principal = await resolveCliPrincipal({
      flagValue: principalFlagValue(args.flags),
      env: deps.env ?? process.env,
      principals: kernel.principals,
    })
  } catch (err) {
    if (err instanceof CliPrincipalError) return { exitCode: 1, stdout: '', stderr: err.message }
    throw err
  }

  const outcome: CommandOutcome = await dispatchCommand(
    {
      registry: kernel.registry,
      activations: kernel.activations,
      principal: { id: principal.id, kind: principal.kind, roles: principal.roles },
      requestId: randomUUID(),
    },
    args,
  )

  const rendered = renderOutcome(outcome, args.flags.json === true)
  return { exitCode: outcome.exitCode, stdout: rendered.stdout, stderr: rendered.stderr }
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2), { env: process.env })
  if (result.stdout.length > 0) console.info(result.stdout)
  if (result.stderr.length > 0) console.error(result.stderr)
  process.exit(result.exitCode)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
