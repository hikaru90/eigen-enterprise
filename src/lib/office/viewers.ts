import type { OfficeKind } from './kinds'
import type { Component } from 'svelte'
import type { DriveItem } from '$lib/drive/api'

/**
 * What the Drive's file page hands an office viewer. The viewer loads the
 * bytes itself (`driveApi.readBytes`) and, when `canEdit`, saves through
 * `createOfficeEditSession` (./edit-session.ts).
 */
export type OfficeViewerProps = {
  fileId: string
  name: string
  /** Edit access and not archived: the viewer may offer editing. */
  canEdit: boolean
  /** The edit-lock heartbeat interval (W-6). */
  heartbeatMs: number
  /** After a save: the file as the server has it now (size, changed time). */
  onsaved?: (file: DriveItem) => void
}

export type OfficeViewerModule = { default: Component<OfficeViewerProps> }

/**
 * Each format's viewer, loaded only when such a file is opened. A format
 * joins with its first milestone (plan/phase-office-files.md); until then
 * the file page keeps its old preview (the browser's PDF viewer; Word and
 * PowerPoint download).
 */
export const OFFICE_VIEWERS: Partial<Record<OfficeKind, () => Promise<OfficeViewerModule>>> = {
  pdf: () => import('./pdf/pdf-viewer.svelte'),
  docx: () => import('./docx/docx-viewer.svelte'),
  pptx: () => import('./pptx/pptx-viewer.svelte'),
}
