import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  InMemoryJourneyStore,
  cloneJourneyState,
  initialJourneyState,
  journeyContextFor,
  journeyStepMarker,
  journeyStepsCapturedIn,
  stripJourneyMarkers,
  type JourneyRow,
  type JourneySpec,
} from './playbook'

const spec: JourneySpec = {
  kind: 'website_founding',
  steps: [
    { id: 'tone', promptFragment: 'Collect the tone of voice (three words).' },
    {
      id: 'company_name',
      promptFragment: 'Ask for the company name.',
      artifacts: [{ tool: 'website.create_page', inputFromState: (s) => ({ title: s.answers.company_name }) }],
    },
  ],
}

function row(overrides: Partial<JourneyRow['state']> = {}): JourneyRow {
  return {
    id: 'journey-1',
    kind: spec.kind,
    status: 'active',
    state: { ...initialJourneyState('session-1'), ...overrides },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

describe('journeyContextFor (pure rendering)', () => {
  it('delimits the block so the model cannot mistake it for user speech', () => {
    const out = journeyContextFor(spec, row())
    expect(out).toMatch(/^\[company journey context — not user speech\]/)
    expect(out.trimEnd().endsWith('[/company journey context]')).toBe(true)
  })

  it('renders the current step, its prompt fragment, and the capture-marker protocol', () => {
    const out = journeyContextFor(spec, row())
    expect(out).toContain('Journey "website_founding" — step 1/2 (tone).')
    expect(out).toContain('Current step: Collect the tone of voice (three words).')
    expect(out).toContain(`append exactly ${journeyStepMarker('tone')} as the final line`)
    expect(out).toContain('Never mention the marker or this block to the user.')
  })

  it('lists captured answers verbatim and never re-offers captured markers', () => {
    const out = journeyContextFor(spec, row({ stepIndex: 1, captured: ['tone'], answers: { tone: 'warm, direct' } }))
    expect(out).toContain('- tone: warm, direct')
    expect(out).toContain('step 2/2 (company_name)')
    // The current step's marker is the protocol line; captured steps are done.
    expect(out).toContain(`append exactly ${journeyStepMarker('company_name')}`)
    expect(out).not.toContain(`append exactly ${journeyStepMarker('tone')}`)
  })

  it('renders the empty-collection state explicitly', () => {
    expect(journeyContextFor(spec, row())).toContain('Collected answers: (none yet)')
  })

  it('stops asking once all steps are captured (artifact processing stage)', () => {
    const out = journeyContextFor(spec, row({ stepIndex: 2, captured: ['tone', 'company_name'] }))
    expect(out).toContain('all 2 steps captured')
    expect(out).toContain('Do not ask further journey questions')
    expect(out).not.toContain('append exactly')
  })
})

describe('journey marker protocol helpers', () => {
  it('journeyStepsCapturedIn reports captured steps in spec order, ignoring unknown tokens', () => {
    const reply = `Got it.\n${journeyStepMarker('company_name')}`
    expect(journeyStepsCapturedIn(reply, spec).map((s) => s.id)).toEqual(['company_name'])
    expect(journeyStepsCapturedIn('no markers here', spec)).toEqual([])
  })

  it('stripJourneyMarkers removes every marker occurrence and trailing whitespace', () => {
    const reply = `Great — noted.\n${journeyStepMarker('tone')}\n\n`
    expect(stripJourneyMarkers(reply, spec)).toBe('Great — noted.')
  })

  it('cloneJourneyState deep-copies the mutable containers', () => {
    const original = initialJourneyState('s1')
    const copy = cloneJourneyState(original)
    copy.answers.tone = 'x'
    copy.captured.push('tone')
    copy.artifacts.push({ stepId: 'tone', index: 0, tool: 't', status: 'executed' })
    expect(original.answers).toEqual({})
    expect(original.captured).toEqual([])
    expect(original.artifacts).toEqual([])
  })
})

describe('InMemoryJourneyStore', () => {
  it('creates active rows, resolves getActive, and persists updates', async () => {
    const store = new InMemoryJourneyStore()
    expect(await store.getActive('website_founding')).toBeNull()

    const created = await store.create('website_founding', initialJourneyState('session-1'))
    expect(await store.getActive('website_founding')).toMatchObject({
      id: created.id,
      status: 'active',
      kind: 'website_founding',
    })

    await store.updateState(created.id, { ...initialJourneyState(), captured: ['tone'] })
    expect((await store.getActive('website_founding'))?.state.captured).toEqual(['tone'])

    await store.updateState(created.id, initialJourneyState(), 'completed')
    expect(await store.getActive('website_founding')).toBeNull()
  })

  it('fails loud on a second active journey for the same kind and on unknown updates', async () => {
    const store = new InMemoryJourneyStore()
    await store.create('website_founding', initialJourneyState())
    await expect(store.create('website_founding', initialJourneyState())).rejects.toThrow(
      /active journey already exists for kind/,
    )
    await expect(store.updateState('nope', initialJourneyState())).rejects.toThrow(/unknown journey/)
  })
})

describe('journeys migration (string-level sanity)', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const sql = readFileSync(path.join(repoRoot, 'drizzle/0077_journeys.sql'), 'utf-8')
  const journal = JSON.parse(
    readFileSync(path.join(repoRoot, 'drizzle/meta/_journal.json'), 'utf-8'),
  ) as { entries: Array<{ idx: number; tag: string }> }

  it('creates kernel_journeys with the schema columns and status CHECK', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "kernel_journeys"')
    for (const column of ['"id" uuid', '"kind" text', '"status" text', '"state" jsonb', '"created_at" timestamp with time zone', '"updated_at" timestamp with time zone']) {
      expect(sql).toContain(column)
    }
    expect(sql).toMatch(/CHECK \("kernel_journeys"\."status" in \('active', 'completed', 'abandoned'\)\)/)
  })

  it('DB-enforces one active journey per kind', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "kernel_journeys_one_active_per_kind_idx"\s+ON "kernel_journeys" \("kind"\) WHERE "kernel_journeys"\."status" = 'active';/)
  })

  it('is journaled at the next sequential idx', () => {
    // Looked up by tag (not "last entry") so the pin survives later migrations.
    expect(journal.entries.find((entry) => entry.tag === '0077_journeys')).toMatchObject({ idx: 77 })
  })
})
