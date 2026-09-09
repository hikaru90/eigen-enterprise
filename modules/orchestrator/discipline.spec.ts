import { describe, expect, it } from 'vitest'
import { ORCHESTRATOR_PERSONA_PROMPT } from './brain'
import {
  REPO_HANDS_SECTION,
  commitConventionsSection,
  disciplineSections,
  loopDetectionSection,
  noFallbacksSection,
  noMidAirRethinksSection,
  planFirstSection,
  understandFirstSection,
} from './discipline'

describe('discipline sections (.pi/skills essence)', () => {
  it('exports tight pure-string sections for each ported skill', () => {
    for (const section of [
      planFirstSection,
      understandFirstSection,
      noFallbacksSection,
      noMidAirRethinksSection,
      loopDetectionSection,
      commitConventionsSection,
      REPO_HANDS_SECTION,
    ]) {
      expect(typeof section).toBe('string')
      expect(section.length).toBeGreaterThan(0)
      expect(section.length).toBeLessThan(1600)
    }
  })

  it('plan-first: plan before editing, read before writing', () => {
    expect(planFirstSection).toMatch(/plan/i)
    expect(planFirstSection).toMatch(/read.*before/i)
  })

  it('understand-first: trace the real code before proposing changes', () => {
    expect(understandFirstSection).toMatch(/read the (actual )?code/i)
    expect(understandFirstSection).toMatch(/root cause/i)
  })

  it('no-fallbacks: fail loud, no silent degradation', () => {
    expect(noFallbacksSection).toMatch(/fail loud/i)
    expect(noFallbacksSection).toMatch(/no fallbacks/i)
  })

  it('no-mid-air-rethinks: finish what you started; rethink before, evaluate after', () => {
    expect(noMidAirRethinksSection).toMatch(/finish what you started/i)
  })

  it('loop-detection: stagnation is the loop signal — stop, summarize, ask', () => {
    expect(loopDetectionSection).toMatch(/stagnation/i)
    expect(loopDetectionSection).toMatch(/ask/i)
  })

  it('commit-conventions: [fix]/[feature]/[chore] preface', () => {
    expect(commitConventionsSection).toMatch(/\[fix\]/)
    expect(commitConventionsSection).toMatch(/\[feature\]/)
    expect(commitConventionsSection).toMatch(/\[chore\]/)
  })

  it('repo hands: the full improvement protocol, in order, with the exact tool names', () => {
    const order = [
      'repo.worktree_create',
      'repo.read_file',
      'repo.write_file',
      'repo.run',
      'repo.merge',
    ]
    let last = -1
    for (const tool of order) {
      expect(REPO_HANDS_SECTION).toContain(tool)
      const at = REPO_HANDS_SECTION.indexOf(tool)
      expect(at, `${tool} out of order`).toBeGreaterThan(last)
      last = at
    }
    expect(REPO_HANDS_SECTION).toMatch(/plan in chat/i)
    expect(REPO_HANDS_SECTION).toMatch(/plan\/progress\.md/)
    expect(REPO_HANDS_SECTION).toMatch(/owner approv/i)
    expect(REPO_HANDS_SECTION).toMatch(/tests green|tests pass|gate/i)
  })

  it('disciplineSections() assembles every section, once each, in a stable order', () => {
    const sections = disciplineSections()
    expect(sections).toEqual([
      planFirstSection,
      understandFirstSection,
      noFallbacksSection,
      noMidAirRethinksSection,
      loopDetectionSection,
      commitConventionsSection,
      REPO_HANDS_SECTION,
    ])
  })

  it('the orchestrator persona system prompt carries the discipline + repo protocol', () => {
    for (const section of disciplineSections()) {
      expect(ORCHESTRATOR_PERSONA_PROMPT).toContain(section)
    }
  })
})
