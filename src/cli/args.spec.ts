import { describe, expect, it } from 'vitest'
import { CliArgsError, parseCliArgs, usageText } from './args'

describe('parseCliArgs', () => {
  it('parses group and action from the first two tokens', () => {
    expect(parseCliArgs(['tool', 'list'])).toEqual({
      group: 'tool',
      action: 'list',
      positionals: [],
      flags: {},
    })
  })

  it('allows a bare group (ee status)', () => {
    expect(parseCliArgs(['status'])).toEqual({
      group: 'status',
      action: undefined,
      positionals: [],
      flags: {},
    })
  })

  it('rejects an empty argv', () => {
    expect(() => parseCliArgs([])).toThrowError(CliArgsError)
    try {
      parseCliArgs([])
    } catch (err) {
      expect((err as CliArgsError).message).toMatch(/usage/i)
    }
  })

  it('rejects flags in the group slot; a flag in the action slot means "no action" (dispatch validates per group)', () => {
    expect(() => parseCliArgs(['--json', 'tool'])).toThrowError(/expected a command group/)
    expect(parseCliArgs(['tool', '--json']).action).toBeUndefined()
  })

  it('collects positionals', () => {
    expect(parseCliArgs(['module', 'activate', 'memory'])).toMatchObject({
      group: 'module',
      action: 'activate',
      positionals: ['memory'],
    })
    expect(parseCliArgs(['tool', 'run', 'memory.capture_thought'])).toMatchObject({
      positionals: ['memory.capture_thought'],
    })
  })

  it('parses --flag value form', () => {
    expect(parseCliArgs(['tool', 'list', '--module', 'memory'])).toMatchObject({
      flags: { module: 'memory' },
    })
  })

  it('parses --flag=value form', () => {
    expect(parseCliArgs(['tool', 'list', '--module=memory'])).toMatchObject({
      flags: { module: 'memory' },
    })
  })

  it('parses JSON payloads containing spaces as a single value token', () => {
    const args = parseCliArgs([
      'tool',
      'run',
      'memory.capture_thought',
      '--input',
      '{"thought":"hello world"}',
    ])
    expect(args.flags.input).toBe('{"thought":"hello world"}')
  })

  it('parses boolean flags (--json, --approve, --deny)', () => {
    expect(parseCliArgs(['approvals', 'decide', 'id-1', '--approve', '--json']).flags).toEqual({
      approve: true,
      json: true,
    })
    expect(parseCliArgs(['approvals', 'decide', 'id-1', '--deny']).flags).toEqual({ deny: true })
  })

  it('supports =-form for boolean flags with true/false', () => {
    expect(parseCliArgs(['status', '--json=true']).flags).toEqual({ json: true })
    expect(parseCliArgs(['status', '--json=false']).flags).toEqual({ json: false })
    expect(() => parseCliArgs(['status', '--json=yes'])).toThrowError(
      /--json expects true or false/,
    )
  })

  it('errors on missing values at end of argv', () => {
    expect(() => parseCliArgs(['tool', 'run', 'x', '--input'])).toThrowError(
      /--input requires a value/,
    )
    expect(() => parseCliArgs(['tool', 'list', '--module'])).toThrowError(
      /--module requires a value/,
    )
  })

  it('errors when a value flag is followed by another flag', () => {
    expect(() => parseCliArgs(['tool', 'run', 'x', '--input', '--json'])).toThrowError(
      /--input requires a value/,
    )
  })

  it('errors on unknown flags, listing supported ones', () => {
    try {
      parseCliArgs(['tool', 'list', '--wat', 'x'])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CliArgsError)
      expect((err as CliArgsError).message).toMatch(/unknown flag --wat/)
      expect((err as CliArgsError).message).toMatch(/--json/)
      expect((err as CliArgsError).message).toMatch(/--module/)
    }
  })

  it('errors on empty flag names', () => {
    expect(() => parseCliArgs(['tool', 'list', '--'])).toThrowError(/flag name/)
    expect(() => parseCliArgs(['tool', 'list', '--=x'])).toThrowError(/flag name/)
  })

  it('lets the last occurrence of a repeated flag win', () => {
    expect(parseCliArgs(['tool', 'list', '--module=memory', '--module=email']).flags).toEqual({
      module: 'email',
    })
  })

  it('accepts flags interleaved with positionals', () => {
    const args = parseCliArgs(['tool', 'run', 'a.b', '--json', 'pos', '--principal=p1'])
    expect(args.positionals).toEqual(['a.b', 'pos'])
    expect(args.flags).toEqual({ json: true, principal: 'p1' })
  })

  it('exposes a usage string listing all supported flags', () => {
    expect(usageText()).toMatch(/ee <group> \[action\] \[positional\.\.\.\]/)
    for (const flag of ['json', 'principal', 'input', 'module', 'status', 'approve', 'deny']) {
      expect(usageText()).toMatch(`--${flag}`)
    }
  })
})
