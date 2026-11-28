/**
 * Which artifact a finished tool step wrote (plan/phase-artifacts.md): the
 * chat opens it in its side panel and refreshes it. Structure only — an
 * artifacts.create/update result names its file as `artifact.id`; any other
 * tool, a failed step or an approval wait names none.
 */
export const ARTIFACT_PANEL_TOOLS: ReadonlySet<string> = new Set(['artifacts.create', 'artifacts.update'])

export type ToolStepArtifact = { fileId: string }

export function artifactOfToolOutcome(tool: string, outcome: unknown): ToolStepArtifact | null {
  if (!ARTIFACT_PANEL_TOOLS.has(tool) || typeof outcome !== 'object' || outcome === null) return null
  const artifact = (outcome as { artifact?: unknown }).artifact
  if (typeof artifact !== 'object' || artifact === null) return null
  const id = (artifact as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? { fileId: id } : null
}
