import type { AssistantController } from './assistant-controller.svelte'
import { getContext, setContext } from 'svelte'

const KEY = Symbol('assistant')

/** What the shell provides: the one assistant, or null while the Assistant plugin is switched off. */
type Provided = { assistant: AssistantController | null }

/**
 * The app shell provides the one assistant to every page inside it — or, with
 * the Assistant plugin switched off, that there is none (off means off).
 */
export function provideAssistant(assistant: AssistantController | null): void {
  setContext<Provided>(KEY, { assistant })
}

function provided(): Provided {
  const value = getContext<Provided | undefined>(KEY)
  if (!value) throw new Error('useAssistant() called outside the app shell')
  return value
}

/**
 * The shell's assistant, for the Assistant's own pages: they render only
 * while it is on (the plugin gate), so a missing one is a bug (fail loud).
 */
export function useAssistant(): AssistantController {
  const { assistant } = provided()
  if (!assistant) throw new Error('useAssistant(): the Assistant plugin is switched off')
  return assistant
}

/** The shell's assistant for core pages (the dashboard): null while the Assistant is switched off. */
export function assistantIfOn(): AssistantController | null {
  return provided().assistant
}
