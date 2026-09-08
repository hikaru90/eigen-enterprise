/**
 * Browser-mode stub for the SvelteKit `$app/forms` virtual module: `enhance` becomes a
 * no-op form action so component specs can render SvelteKit forms without the plugin.
 */
export function enhance(): { destroy: () => void } {
  return { destroy: () => undefined }
}
export const applyAction = (): Promise<void> => Promise.resolve()
export const deserialize = (value: unknown): unknown => value
