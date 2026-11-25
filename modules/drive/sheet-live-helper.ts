import type { DriveService, ItemView } from './service'
import { createHash, randomUUID } from 'node:crypto'
import { pinChange, type ChangeBody } from '$lib/office/xlsx/collab/protocol'
import type { SheetEditor } from '$lib/office/xlsx/editor'
import type { SheetOp } from '$lib/office/xlsx/ops'
import type { SheetLive } from '$lib/server/sheet-live/service'
import { officeKind } from './preview'
import { DriveError } from './service'

type AppliedRecord = { op: SheetOp; acceptLosses: boolean }
type LiveEditorContext = {
  live: SheetLive
  file: ItemView
  seq: number
  applied: AppliedRecord[]
}

const liveEditors = new WeakMap<SheetEditor, LiveEditorContext>()

function trackEditor(inner: SheetEditor, live: SheetLive, file: ItemView, seq: number): SheetEditor {
  const applied: AppliedRecord[] = []
  const tracked: SheetEditor = {
    wb: inner.wb,
    calc: () => inner.calc(),
    apply(op, opts) {
      const res = inner.apply(op, opts)
      applied.push({ op, acceptLosses: !!opts?.acceptLosses })
      return res
    },
    losses: (op) => inner.losses(op),
    undo: () => inner.undo(),
    redo: () => inner.redo(),
    canUndo: () => inner.canUndo(),
    canRedo: () => inner.canRedo(),
    version: () => inner.version(),
    changed: () => inner.changed(),
    toBytes: () => inner.toBytes(),
  }
  liveEditors.set(tracked, { live, file, seq, applied })
  return tracked
}

function toChangeBodies(applied: AppliedRecord[]): ChangeBody[] {
  const out: ChangeBody[] = []
  for (const item of applied) {
    const prev = out.at(-1)
    if (prev && prev.acceptLosses === item.acceptLosses && prev.ops.length < 200) {
      prev.ops.push(item.op)
    } else {
      out.push({ kind: 'change', ops: [item.op], acceptLosses: item.acceptLosses })
    }
  }
  // As they travel: bytes encoded, comment times set (every replica writes the same).
  return out.map((b) => pinChange(b))
}

export async function openLiveAwareBook<
  Lib extends {
    editor: { createSheetEditor: (bytes: Uint8Array) => SheetEditor }
    workbook: { XlsxError: new (...a: never[]) => Error }
    ref: { XlsxRefError: new (...a: never[]) => Error }
    opc: { OpcError: new (...a: never[]) => Error }
  },
>(
  drive: DriveService,
  actor: { kind: 'user'; userId: string } | { kind: 'agent'; id: string },
  id: string,
  lib: Lib,
  guarded: <T>(lib: Lib, work: () => T | Promise<T>) => Promise<T>,
  sheetLive?: () => Promise<SheetLive>,
): Promise<{ file: { id: string; name: string }; editor: SheetEditor; base: string }> {
  const live = sheetLive ? await sheetLive() : null
  const active = live ? await live.book(actor, id) : null
  if (live && active) {
    const inner = await guarded(lib, () => lib.editor.createSheetEditor(active.bytes))
    return {
      file: active.file,
      editor: trackEditor(inner, live, active.file, active.seq),
      base: active.baseSha256,
    }
  }
  const { file, bytes } = await drive.readFile(actor, id)
  if (officeKind(file.name, file.mime) !== 'xlsx')
    throw new DriveError('invalid', `“${file.name}” is not an Excel workbook (.xlsx).`)
  const editor = await guarded(lib, () => lib.editor.createSheetEditor(bytes))
  return { file, editor, base: createHash('sha256').update(bytes).digest('hex') }
}

export type LiveAwareSaved = {
  file: ItemView | { id: string; name: string }
  revision: { id: string; createdAt: Date } | null
}

export async function saveLiveAwareBook(
  drive: DriveService,
  actor: { kind: 'user'; userId: string } | { kind: 'agent'; id: string },
  id: string,
  editor: SheetEditor,
  base: string,
): Promise<LiveAwareSaved> {
  const ctxLive = liveEditors.get(editor)
  if (ctxLive) {
    const changes = toChangeBodies(ctxLive.applied)
    if (changes.length === 0) return { file: ctxLive.file, revision: null }
    const res = await ctxLive.live.commit(actor, id, ctxLive.seq, changes, `tool:${randomUUID()}`)
    return res.saved ?? { file: ctxLive.file, revision: null }
  }
  const out = await drive.writeBytes(actor, id, editor.toBytes(), undefined, {
    baseSha256: base,
  })
  return { file: out.file, revision: { id: out.revision.id, createdAt: out.revision.createdAt } }
}
