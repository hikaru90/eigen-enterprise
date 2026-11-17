import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import TimelineAddTask from './timeline-add-task.svelte'

const field = () => page.getByRole('textbox', { name: 'Add a task' })
const addButton = () => page.getByRole('button', { name: 'Add task' })

describe('Memory › Tasks: add a task right there (Contribute e7bdd452)', () => {
  it('adds what was typed as a task and clears the field for the next one', async () => {
    const addTask = vi.fn(async () => {})
    render(TimelineAddTask, { addTask })

    await expect.element(addButton()).toBeDisabled()
    await field().fill('  Renew the passport  ')
    await addButton().click()

    expect(addTask).toHaveBeenCalledWith('Renew the passport')
    await expect.element(field()).toHaveValue('')
  })

  it('Enter adds it too', async () => {
    const addTask = vi.fn(async () => {})
    render(TimelineAddTask, { addTask })

    await field().fill('Call the bank')
    await userEvent.keyboard('{Enter}')

    expect(addTask).toHaveBeenCalledWith('Call the bank')
  })

  it('says so when it could not be added, and keeps the text', async () => {
    const addTask = vi.fn(async () => {
      throw new Error('Capture failed (500)')
    })
    render(TimelineAddTask, { addTask })

    await field().fill('Book the dentist')
    await addButton().click()

    await expect.element(page.getByRole('alert')).toHaveTextContent(/Capture failed \(500\)/)
    await expect.element(field()).toHaveValue('Book the dentist')
  })
})
