import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import PluginsPage from './+page.svelte'

type Ref = { id: string; name: string; active: boolean }
const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  version: '0.1.0',
  description: `${name} for the company.`,
  origin: 'official',
  active: true,
  tools: [`${id}.list`, `${id}.send`],
  requires: [] as Ref[],
  requiredBy: [] as Ref[],
  ...over,
})

const PLUGINS = [
  row('messages', 'Messages', { requiredBy: [{ id: 'calls', name: 'Calls', active: true }] }),
  row('calls', 'Calls', { requires: [{ id: 'messages', name: 'Messages', active: true }] }),
  row('drive', 'Drive', { active: false, tools: [] }),
]
const CORE = [
  { id: 'kernel', name: 'Kernel' },
  { id: 'members', name: 'Members' },
]

const props = (form: unknown = null, plugins = PLUGINS) => ({ data: { plugins, core: CORE }, form, params: {} }) as never

describe('Settings → Plugins page', () => {
  it('lists every plugin as official, on or off, with what it needs and what needs it', async () => {
    render(PluginsPage, props())
    const messages = page.getByTestId('plugin-messages')
    await expect.element(messages).toHaveTextContent('Messages')
    await expect.element(messages.getByTestId('plugin-origin')).toHaveTextContent('Official')
    await expect.element(messages.getByTestId('plugin-state')).toHaveTextContent('On')
    await expect.element(messages).toHaveTextContent('Needed by Calls')
    await expect.element(page.getByTestId('plugin-calls')).toHaveTextContent('Needs Messages')
    await expect.element(page.getByTestId('plugin-drive').getByTestId('plugin-state')).toHaveTextContent('Off')
    await expect.element(page.getByTestId('plugin-switch-messages')).toHaveAttribute('aria-checked', 'true')
    await expect.element(page.getByTestId('plugin-switch-drive')).toHaveAttribute('aria-checked', 'false')
  })

  it('shows the core as one line that cannot be switched off, and no company group while there is none', async () => {
    render(PluginsPage, props())
    await expect.element(page.getByTestId('plugins-core')).toHaveTextContent('Kernel, Members')
    await expect.element(page.getByTestId('plugins-core')).toHaveTextContent('cannot be switched off')
    await expect.element(page.getByTestId('plugins-company')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('plugin-switch-kernel')).not.toBeInTheDocument()
  })

  it('switching off asks first: what goes, that the data is kept — and cancel leaves it on', async () => {
    render(PluginsPage, props())
    await page.getByTestId('plugin-switch-calls').click()
    const confirm = page.getByTestId('plugin-confirm-calls')
    await expect.element(confirm).toHaveTextContent('Switch off Calls?')
    await expect.element(confirm).toHaveTextContent('sidebar')
    await expect.element(confirm).toHaveTextContent('The agent can no longer use its 2 tools')
    await expect.element(confirm).toHaveTextContent('Everything it has stored is kept')
    await expect.element(confirm.getByRole('button', { name: 'Switch off' })).toHaveAttribute('type', 'submit')
    await expect
      .element(page.getByTestId('plugin-confirm-form-calls'))
      .toHaveAttribute('action', '?/deactivate')
    await expect.element(page.getByTestId('plugin-switch-calls')).toHaveAttribute('aria-checked', 'true')
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(confirm).not.toBeInTheDocument()
    await expect.element(page.getByTestId('plugin-switch-calls')).toHaveAttribute('aria-checked', 'true')
  })

  it('says up front which plugins need the one being switched off', async () => {
    render(PluginsPage, props())
    await page.getByTestId('plugin-switch-messages').click()
    await expect.element(page.getByTestId('plugin-confirm-messages')).toHaveTextContent('Calls needs it')
  })

  it('switching on is a direct switch: the activate form for that plugin', async () => {
    render(PluginsPage, props())
    await expect.element(page.getByTestId('plugin-activate-form-drive')).toHaveAttribute('action', '?/activate')
    await expect.element(page.getByTestId('plugin-confirm-drive')).not.toBeInTheDocument()
  })

  it('shows the kernel’s refusal as it is, on the plugin it belongs to', async () => {
    render(
      PluginsPage,
      props({ action: 'deactivate', moduleId: 'messages', error: 'Calls needs Messages: switch off Calls first.' }),
    )
    await expect
      .element(page.getByTestId('plugin-messages').getByRole('alert'))
      .toHaveTextContent('Calls needs Messages: switch off Calls first.')
    await expect.element(page.getByTestId('plugin-calls').getByRole('alert')).not.toBeInTheDocument()
  })

  it('lists company plugins in their own group once there are any', async () => {
    render(PluginsPage, props(null, [...PLUGINS, row('crm', 'CRM', { origin: 'company' })]))
    await expect.element(page.getByTestId('plugins-company').getByTestId('plugin-crm')).toBeInTheDocument()
    await expect.element(page.getByTestId('plugin-crm').getByTestId('plugin-origin')).toHaveTextContent('Company')
  })
})
