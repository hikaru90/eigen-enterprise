import { describe, expect, it } from 'vitest'
import { PI_GUARDRAILS, buildPiPrompt } from './prompt'

describe('buildPiPrompt', () => {
  it('embeds the task text verbatim, followed by the guardrails', () => {
    const task = 'Fix the flaky owlery retry test in src/lib/server.'
    const prompt = buildPiPrompt(task)
    expect(prompt.startsWith(task)).toBe(true)
    expect(prompt).toContain(PI_GUARDRAILS)
    expect(prompt.indexOf(task)).toBeLessThan(prompt.indexOf(PI_GUARDRAILS))
  })

  it('carries the mandatory engineering contract markers', () => {
    const prompt = buildPiPrompt('t')
    // tests must pass, per touched scope
    expect(prompt).toContain('npx vitest run')
    // typecheck must not add errors beyond the known baseline
    expect(prompt).toContain('npm run check')
    expect(prompt).toContain('5 known baseline errors')
    // commit conventions
    expect(prompt).toContain('single commit')
    expect(prompt).toContain('imperative commit message')
    // secrets
    expect(prompt).toContain('Never commit or log secrets')
    // no weakening tests
    expect(prompt).toContain('Never weaken tests')
    // AGENTS.md is law
    expect(prompt).toContain('AGENTS.md is law')
    // no fallbacks
    expect(prompt).toContain('fail loud')
  })

  it('is a pure function: identical inputs produce identical prompts', () => {
    expect(buildPiPrompt('a')).toBe(buildPiPrompt('a'))
    expect(buildPiPrompt('a')).not.toBe(buildPiPrompt('b'))
  })
})
