/** What the picker page ships to the client per node (tokens stay on the server). */
export type PickerCard = {
  id: string
  level: 'genre' | 'style' | 'variant'
  parentId: string | null
  name: string
  description: string
  preview: { light: string; dark: string }
}

export type PreviewMode = 'light' | 'dark'

/** The picker's URL state on /brand: `?style=<node id>`; no query = the genres. */
export function pickerQuery(nodeId: string): string {
  return `?style=${encodeURIComponent(nodeId)}`
}
