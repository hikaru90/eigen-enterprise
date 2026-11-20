/**
 * pdf.js in the browser, loaded the first time a PDF is opened. Parsing runs
 * in pdf.js's worker; pages are drawn in its renderer worker (OffscreenCanvas)
 * where the browser has one, else on the main thread — pdf.js decides.
 *
 * The data pdf.js reads on demand — CMaps (CJK text), the standard 14 fonts,
 * the JPEG 2000 / JBIG2 decoders (WebAssembly) — is bundled as plain assets
 * and handed over by file name (BinaryDataFactory), so no static folder has
 * to be served next to the app.
 */
import type * as PdfJsModule from 'pdfjs-dist'

export type PdfJs = typeof PdfJsModule
export type PdfDocument = PdfJsModule.PDFDocumentProxy
export type PdfPage = PdfJsModule.PDFPageProxy
export type PdfLoadingTask = PdfJsModule.PDFDocumentLoadingTask

const ASSETS = import.meta.glob<string>(
  [
    '/node_modules/pdfjs-dist/cmaps/*.bcmap',
    '/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
    '/node_modules/pdfjs-dist/wasm/*.wasm',
  ],
  { query: '?url&no-inline', import: 'default', eager: true },
)

const FOLDER = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as const

/** The URL of one of pdf.js's data files (`kind` as pdf.js names the folder). */
export function pdfAssetUrl(kind: keyof typeof FOLDER, filename: string): string {
  const url = ASSETS[`/node_modules/pdfjs-dist/${FOLDER[kind]}/${filename}`]
  if (!url) throw new Error(`pdf.js asked for ${FOLDER[kind]}/${filename}, which is not bundled.`)
  return url
}

/** pdf.js calls `fetch({ kind, filename })` when the worker needs a data file. */
class BundledData {
  async fetch({
    kind,
    filename,
  }: {
    kind: keyof typeof FOLDER
    filename: string
  }): Promise<Uint8Array> {
    const url = pdfAssetUrl(kind, filename)
    const res = await fetch(url)
    if (!res.ok)
      throw new Error(`Loading ${FOLDER[kind]}/${filename} for the PDF failed (${res.status}).`)
    return new Uint8Array(await res.arrayBuffer())
  }
}

let loaded: Promise<PdfJs> | null = null

export function loadPdfJs(): Promise<PdfJs> {
  loaded ??= (async () => {
    const [lib, worker, renderer] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      import('pdfjs-dist/build/pdf.renderer.min.mjs?url'),
    ])
    lib.GlobalWorkerOptions.workerSrc = worker.default
    lib.GlobalWorkerOptions.rendererSrc = renderer.default
    return lib
  })()
  return loaded
}

/**
 * Starts opening a PDF. `onPassword` is called when the file needs one
 * (`incorrect`: the last try was wrong); the viewer answers through `submit`.
 * The password goes straight to pdf.js and is kept nowhere else.
 */
export async function openPdf(
  bytes: Uint8Array,
  onPassword: (submit: (password: string) => void, incorrect: boolean) => void,
): Promise<PdfLoadingTask> {
  const lib = await loadPdfJs()
  const task = lib.getDocument({
    data: bytes,
    cMapPacked: true,
    BinaryDataFactory: BundledData,
    enableXfa: false,
  })
  task.onPassword = (submit: (password: string) => void, reason: number) =>
    onPassword(submit, reason === lib.PasswordResponses.INCORRECT_PASSWORD)
  return task
}
