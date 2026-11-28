import type { ModuleManifest } from '$lib/kernel/modules'

export const DRIVE_MODULE_ID = 'drive'

/** Looking at images and PDFs through a vision model (./image-tools.ts): a read. */
export const DRIVE_IMAGE_TOOL_NAMES = ['drive.view_image'] as const

/** PDF page organisation (plan/phase-office-files.md P2, ./pdf-tools.ts): every one writes, so each waits on the approval mode. */
export const DRIVE_PDF_TOOL_NAMES = [
  'drive.pdf_rotate',
  'drive.pdf_delete_pages',
  'drive.pdf_reorder',
  'drive.pdf_extract_pages',
  'drive.pdf_split',
  'drive.pdf_merge',
] as const

/** PDF annotations, forms and properties (plan/phase-office-files.md P3, ./pdf-tools-annotate.ts): two reads, five writes. */
export const DRIVE_PDF_ANNOTATE_TOOL_NAMES = [
  'drive.pdf_list_annotations',
  'drive.pdf_add_note',
  'drive.pdf_reply',
  'drive.pdf_edit_annotations',
  'drive.pdf_list_form_fields',
  'drive.pdf_fill_form',
  'drive.pdf_set_properties',
] as const

/** Excel workbooks (./sheet-tools.ts, ./sheet-format-tools.ts, ./sheet-arrange-tools.ts, ./sheet-chart-tools.ts, ./sheet-pivot-table-tools.ts, ./sheet-editing-tools.ts, ./sheet-rules-tools.ts, ./sheet-drawing-tools.ts, ./sheet-comment-tools.ts, the Drive's spreadsheet editor): reads + writes. */
export const DRIVE_SHEET_TOOL_NAMES = [
  'drive.sheet_read',
  'drive.sheet_write',
  'drive.sheet_structure',
  'drive.sheet_format',
  'drive.sheet_sort',
  'drive.sheet_filter',
  'drive.sheet_freeze',
  'drive.sheet_table_create',
  'drive.sheet_table_update',
  'drive.sheet_table_delete',
  'drive.sheet_pivot_create',
  'drive.sheet_pivot_update',
  'drive.sheet_pivot_refresh',
  'drive.sheet_pivot_delete',
  'drive.sheet_chart_list',
  'drive.sheet_chart_create',
  'drive.sheet_chart_update',
  'drive.sheet_chart_delete',
  'drive.sheet_picture_insert',
  'drive.sheet_picture_update',
  'drive.sheet_picture_delete',
  'drive.sheet_shape_create',
  'drive.sheet_shape_update',
  'drive.sheet_shape_delete',
  'drive.sheet_comment_list',
  'drive.sheet_comment_add',
  'drive.sheet_comment_reply',
  'drive.sheet_comment_edit',
  'drive.sheet_comment_resolve',
  'drive.sheet_comment_delete',
  'drive.sheet_copy_range',
  'drive.sheet_fill',
  'drive.sheet_find_replace',
  'drive.sheet_merge',
  'drive.sheet_rows_cols',
  'drive.sheet_tab',
  'drive.sheet_export_pdf',
  'drive.sheet_conditional_format_list',
  'drive.sheet_conditional_format_set',
  'drive.sheet_conditional_format_delete',
  'drive.sheet_validation_set',
  'drive.sheet_validation_clear',
  'drive.sheet_hyperlink_set',
  'drive.sheet_hyperlink_remove',
  'drive.sheet_names_list',
  'drive.sheet_names_set',
  'drive.sheet_names_delete',
  'drive.sheet_protect',
] as const

/** The spreadsheet writes: each waits on the approval mode (wired in modules/index.ts). */
export const DRIVE_SHEET_WRITE_TOOLS = [
  'drive.sheet_write',
  'drive.sheet_structure',
  'drive.sheet_format',
  'drive.sheet_sort',
  'drive.sheet_filter',
  'drive.sheet_freeze',
  'drive.sheet_table_create',
  'drive.sheet_table_update',
  'drive.sheet_table_delete',
  'drive.sheet_pivot_create',
  'drive.sheet_pivot_update',
  'drive.sheet_pivot_refresh',
  'drive.sheet_pivot_delete',
  'drive.sheet_chart_create',
  'drive.sheet_chart_update',
  'drive.sheet_chart_delete',
  'drive.sheet_picture_insert',
  'drive.sheet_picture_update',
  'drive.sheet_picture_delete',
  'drive.sheet_shape_create',
  'drive.sheet_shape_update',
  'drive.sheet_shape_delete',
  'drive.sheet_comment_add',
  'drive.sheet_comment_reply',
  'drive.sheet_comment_edit',
  'drive.sheet_comment_resolve',
  'drive.sheet_comment_delete',
  'drive.sheet_copy_range',
  'drive.sheet_fill',
  'drive.sheet_find_replace',
  'drive.sheet_merge',
  'drive.sheet_rows_cols',
  'drive.sheet_tab',
  'drive.sheet_conditional_format_set',
  'drive.sheet_conditional_format_delete',
  'drive.sheet_validation_set',
  'drive.sheet_validation_clear',
  'drive.sheet_hyperlink_set',
  'drive.sheet_hyperlink_remove',
  'drive.sheet_names_set',
  'drive.sheet_names_delete',
  'drive.sheet_protect',
] as const

/** Co-editing a workbook (./sheet-live-tools.ts, plan/phase-office-files.md §7.9): the grid's join, log read and batch send. */
export const DRIVE_SHEET_LIVE_TOOL_NAMES = [
  'drive.sheet_live_join',
  'drive.sheet_live_entries',
  'drive.sheet_live_submit',
] as const

/** The co-editing write (a batch of changes): waits on the approval mode like the other sheet writes. */
export const DRIVE_SHEET_LIVE_WRITE_TOOLS = ['drive.sheet_live_submit'] as const

/** .xls / .ods, shown read-only (./sheet-copy-tools.ts): Make an editable .xlsx copy — a write, waits on the approval mode. */
export const DRIVE_SHEET_COPY_TOOL_NAMES = ['drive.make_xlsx_copy'] as const

/** File management with UI parity (./file-tools.ts): New folder, Upload, Rename, Move, Share, Trash, Versions. */
export const DRIVE_FILE_TOOL_NAMES = [
  'drive.create_folder',
  'drive.upload',
  'drive.save_file_bytes',
  'drive.list_revisions',
  'drive.restore_revision',
  'drive.rename',
  'drive.move',
  'drive.trash',
  'drive.list_trash',
  'drive.restore',
  'drive.delete_forever',
  'drive.get_sharing',
  'drive.set_sharing',
] as const

/** The selection bar's acts on several items at once (./file-tools.ts; per-item results). */
export const DRIVE_BULK_TOOL_NAMES = [
  'drive.move_many',
  'drive.trash_many',
  'drive.restore_many',
  'drive.delete_forever_many',
  'drive.share_many',
] as const

/** The file-management writes: each waits on the approval mode (wired in modules/index.ts). */
export const DRIVE_WRITE_TOOLS = [
  'drive.create_folder',
  'drive.upload',
  'drive.save_file_bytes',
  'drive.restore_revision',
  'drive.rename',
  'drive.move',
  'drive.trash',
  'drive.restore',
  'drive.delete_forever',
  'drive.set_sharing',
  ...DRIVE_BULK_TOOL_NAMES,
] as const

/** Artifacts (./artifact-tools.ts, plan/phase-artifacts.md): HTML pages and slide decks agents write; the artifacts namespace. */
export const ARTIFACT_TOOL_NAMES = ['artifacts.create', 'artifacts.update', 'artifacts.read', 'artifacts.export_pdf', 'artifacts.export_pptx'] as const
/** The artifact writes: each waits on the approval mode (wired in modules/index.ts). */
export const ARTIFACT_WRITE_TOOLS = ['artifacts.create', 'artifacts.update', 'artifacts.export_pdf', 'artifacts.export_pptx'] as const

export const DRIVE_TOOL_NAMES = [
  'drive.list',
  'drive.shared_with_me',
  'drive.read',
  'drive.write_text',
  'drive.create_document',
  'drive.archive',
  'drive.unarchive',
  'drive.list_archived',
  'drive.suggest_archive',
  'drive.app_status',
  'drive.app_run',
  'drive.app_stop',
  ...DRIVE_FILE_TOOL_NAMES,
  ...DRIVE_BULK_TOOL_NAMES,
  ...DRIVE_PDF_TOOL_NAMES,
  ...DRIVE_IMAGE_TOOL_NAMES,
  ...DRIVE_PDF_ANNOTATE_TOOL_NAMES,
  ...DRIVE_SHEET_TOOL_NAMES,
  ...DRIVE_SHEET_COPY_TOOL_NAMES,
  ...DRIVE_SHEET_LIVE_TOOL_NAMES,
  ...ARTIFACT_TOOL_NAMES,
] as const

/**
 * Drive: the company's files and folders (plan/phase-workspace.md D1). A
 * system module (self-seeded active); the people's surface is /drive, the
 * agent's is these tools — every call access-checked like a page request.
 */
export const driveManifest: ModuleManifest = {
  id: DRIVE_MODULE_ID,
  name: 'Drive',
  version: '0.3.0',
  description:
    'Folders and files for the whole company: upload, share, preview; Markdown and CSV keep revisions; Excel workbooks open as an editable grid; archive what is done with (AI suggestions you confirm); run a web app folder and see it live (admins); artifacts: HTML pages and slide decks the assistant builds, rendered next to the chat.',
  toolNamespaces: ['drive', 'artifacts'],
  tools: [...DRIVE_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
