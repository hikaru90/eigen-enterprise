/**
 * Zero-dependency argv parser for the ee CLI.
 *
 * Grammar: ee <group> [action] [positional...] [--flag value | --flag=value]
 * Value flags: principal, input, module, status. Boolean flags: json, approve, deny.
 * Pure function: throws CliArgsError on any malformed input — no process IO here.
 */

export type ParsedCliArgs = {
  group: string
  action: string | undefined
  positionals: string[]
  flags: Record<string, string | boolean>
}

export class CliArgsError extends Error {}

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['json', 'approve', 'deny'])
const VALUE_FLAGS: ReadonlySet<string> = new Set(['principal', 'input', 'module', 'status'])

export const KNOWN_FLAGS: readonly string[] = [...BOOLEAN_FLAGS, ...VALUE_FLAGS]

export function usageText(): string {
  const flags = KNOWN_FLAGS.map((f) => `--${f}`).join(', ')
  return [
    'usage: ee <group> [action] [positional...] [flags]',
    `flags: ${flags}`,
    'boolean flags (--json, --approve, --deny) take no value; others require one (--flag value or --flag=value)',
  ].join('\n')
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  if (argv.length === 0) {
    throw new CliArgsError(`no command given\n${usageText()}`)
  }

  const group = requireToken(argv[0], 'command group')
  if (group.startsWith('--')) {
    throw new CliArgsError(`expected a command group, got flag "${group}"\n${usageText()}`)
  }

  let action: string | undefined
  let rest = argv.slice(1)
  if (rest.length > 0 && !rest[0].startsWith('--')) {
    action = rest[0]
    rest = rest.slice(1)
  }

  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const name = token.slice(2)
    if (name.length === 0 || name.startsWith('=')) {
      throw new CliArgsError(`empty flag name in "${token}"\n${usageText()}`)
    }

    const eq = name.indexOf('=')
    if (eq >= 0) {
      applyFlag(flags, name.slice(0, eq), { inline: name.slice(eq + 1) }, token)
      continue
    }

    if (BOOLEAN_FLAGS.has(name)) {
      applyFlag(flags, name, { boolean: true }, token)
      continue
    }

    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new CliArgsError(`flag --${name} requires a value\n${usageText()}`)
    }
    applyFlag(flags, name, { inline: value }, token)
    i++
  }

  return { group, action, positionals, flags }
}

function requireToken(token: string | undefined, what: string): string {
  if (token === undefined) throw new CliArgsError(`missing ${what}\n${usageText()}`)
  return token
}

function applyFlag(
  flags: Record<string, string | boolean>,
  name: string,
  value: { inline: string } | { boolean: true },
  rawToken: string,
): void {
  if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
    throw new CliArgsError(`unknown flag ${rawToken}\n${usageText()}`)
  }
  if ('boolean' in value) {
    flags[name] = true
    return
  }
  if (BOOLEAN_FLAGS.has(name)) {
    if (value.inline !== 'true' && value.inline !== 'false') {
      throw new CliArgsError(
        `flag --${name} expects true or false, got "${value.inline}"\n${usageText()}`,
      )
    }
    flags[name] = value.inline === 'true'
    return
  }
  flags[name] = value.inline
}
