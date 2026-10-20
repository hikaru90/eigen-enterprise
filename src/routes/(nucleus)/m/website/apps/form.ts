import type { AppContract, ContractForm } from '../../../../../../modules/website/apps/contract'

/** A stored contract as build-form values (argv joined back with spaces), for a redeploy. */
export function contractFields(c: AppContract | null) {
  if (!c) return null
  const words = (a: string[] | undefined) => (a ?? []).join(' ')
  return {
    runtime: c.runtime === 'node' ? `node@${c.node ?? ''}` : 'static',
    install: words(c.build[0]),
    build: words(c.build[1]),
    start: words(c.start),
    portEnv: c.portEnv ?? '',
    health: c.health,
    staticDir: c.staticDir ?? '',
  }
}

const field = (f: FormData, name: string) => String(f.get(name) ?? '').trim()
const optional = (v: string) => (v === '' ? undefined : v)

/** The build form as the deploy tool takes it; null when the owner left it empty (the repo has ee.json). */
export function formContract(f: FormData): ContractForm | null {
  if (field(f, 'useForm') !== 'on') return null
  const runtimeField = field(f, 'runtime')
  const [runtime, nodeVersion] = runtimeField.startsWith('node@')
    ? ['node', runtimeField.slice(5)]
    : [runtimeField, undefined]
  return {
    runtime: runtime as 'node' | 'static',
    ...(nodeVersion ? { nodeVersion } : {}),
    install: field(f, 'install'),
    build: field(f, 'build'),
    start: field(f, 'start'),
    health: field(f, 'health') || '/',
    ...(optional(field(f, 'portEnv')) ? { portEnv: field(f, 'portEnv') } : {}),
    ...(optional(field(f, 'staticDir')) ? { staticDir: field(f, 'staticDir') } : {}),
  }
}
