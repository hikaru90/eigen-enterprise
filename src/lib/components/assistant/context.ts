import type { AssistantController } from './assistant-controller.svelte'
import { getContext, setContext } from 'svelte'

const KEY = Symbol('assistant')

/** The app shell provides the one assistant to every page inside it. */
export function provideAssistant(assistant: AssistantController): void {
  setContext(KEY, assistant)
}

/** The shell's assistant. Only pages inside the shell may ask for it. */
export function useAssistant(): AssistantController {
  const assistant = getContext<AssistantController | undefined>(KEY)
  if (!assistant) throw new Error('useAssistant() called outside the app shell')
  return assistant
}
