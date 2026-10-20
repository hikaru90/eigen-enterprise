import type { ContractForm } from '../../../../../../modules/website/apps/contract'

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
