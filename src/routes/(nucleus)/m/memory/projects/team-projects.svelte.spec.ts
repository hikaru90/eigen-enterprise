import type { TemporalEventListItem } from '../../../../api/temporal-events/+server'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { ProjectForReader } from '$lib/server/memory/team-projects'
import ProjectListView from '../../../../timeline/project-list-view.svelte'
import TimelineCreateProjectDialog from '../../../../timeline/timeline-create-project-dialog.svelte'
import TeamProjectsList from './team-projects-list.svelte'

/** Memory › Projects, shared (plan/shared-memory-voice-agent-tools.md §1). */
const teamProject = (over: Partial<ProjectForReader> = {}): ProjectForReader => ({
  entityId: 'p1',
  label: 'Website relaunch',
  visibility: 'company',
  status: 'active',
  source: 'manual',
  nextAction: { thoughtId: 't1', summary: 'Draft the landing page copy', itemId: 'task:t1' },
  openTaskCount: 2,
  targetDate: null,
  tasks: [{ thoughtId: 't1', summary: 'Draft the landing page copy', itemId: 'task:t1', rank: 1 }],
  milestones: [],
  owner: { id: 'u2', name: 'Ana' },
  editable: false,
  ...over,
})

describe('Team projects', () => {
  it('lists colleagues’ shared projects with their owner, progress and next task, opening the project', async () => {
    render(TeamProjectsList, { projects: [teamProject()] })
    const card = page.getByTestId('team-project-card')
    await expect.element(card).toHaveTextContent('Website relaunch')
    await expect.element(card).toHaveTextContent('By Ana · Read-only')
    await expect.element(card).toHaveTextContent('Draft the landing page copy')
    await expect.element(card).toHaveAttribute('href', '/m/memory/projects/p1')
  })

  it('says so when no colleague shares a project', async () => {
    render(TeamProjectsList, { projects: [] })
    await expect.element(page.getByText('No colleague shares a project yet.')).toBeVisible()
  })
})

describe('a colleague’s project page lists its tasks read-only', () => {
  const item = {
    id: 'task:t1',
    thoughtId: 't1',
    semanticSummary: 'Draft the landing page copy',
    lifecycleStatus: 'open',
    thoughtStatus: 'open',
    startAt: null,
    endAt: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    author: 'user',
    authorLabel: null,
  } as unknown as TemporalEventListItem

  it('no status button, no opening a task to change it', async () => {
    const onSelect = vi.fn()
    const onQuickAction = vi.fn()
    render(ProjectListView, { items: [item], onSelect, onQuickAction, readOnly: true })
    await expect.element(page.getByText('Draft the landing page copy')).toBeVisible()
    expect(page.getByRole('button').elements()).toHaveLength(0)
    await page.getByText('Draft the landing page copy').click()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('the owner’s own list keeps its buttons', async () => {
    render(ProjectListView, { items: [item], onSelect: vi.fn(), onQuickAction: vi.fn() })
    expect(page.getByRole('button').elements().length).toBeGreaterThan(0)
  })
})

describe('a new project', () => {
  it('is shared unless the person switches it to Private, and the choice is sent with it', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        entityId: 'p9',
        label: 'Job search',
        status: 'active',
        visibility: 'private',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(TimelineCreateProjectDialog, { open: true, onClose: () => {}, onCreated: () => {} })
    const toggle = page.getByRole('switch', { name: 'Private' })
    await expect.element(toggle).not.toBeChecked()
    await page.getByRole('textbox').fill('Job search')
    await toggle.click()
    await page
      .getByRole('button', { name: /create|add/i })
      .last()
      .click()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ label: 'Job search', private: true })
    vi.unstubAllGlobals()
  })
})
