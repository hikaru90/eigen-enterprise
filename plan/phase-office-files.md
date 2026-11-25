# Phase: Office files in the Drive (PDF, DOCX, PPTX)

**Status:** approved by the owner 2026-11-20 (TypeScript-first, §2). Foundation F landed on `main`; the three streams run in parallel worktrees.

**Goal:** opening a `.pdf`, `.docx` or `.pptx` in the Drive opens a real viewer/editor of our own. Today a PDF is a bare browser `<iframe>` and Word/PowerPoint files fall through to "download" (`modules/drive/preview.ts` → `other`). We use three open-source projects as the reference for *what* to build, not *how*:

| Our handler | Reference (features only) | Reference licence | Reference stack |
|---|---|---|---|
| PDF | storytold/pdfcraft | MIT OR Apache-2.0 | Rust; whole UI drawn on the GPU (egui/wgpu), web build compiled to WASM |
| DOCX | eigenpal/docx-editor | Apache-2.0 core; tracked changes, comments, collaboration, PDF export and its API are under an **evaluation-only licence** | TypeScript, ProseMirror, a pagination pass that runs without the DOM |
| PPTX | eigenpal/pptx-editor | same split as docx-editor; also includes Ecma-copyrighted tables | TypeScript, slides painted as SVG |

## 1. Clean-room rules (binding for every implementing agent)

- Implementers **never open the reference repos' source, never install their packages** (`@eigenpal/*`, `@docx-editor.dev/*`, `pdfcraft*`), and never copy their tests or fixtures. They work only from this plan and the public standards: ISO 32000-2 (PDF 2.0, free from the PDF Association), ECMA-376 (OOXML) and the Open Packaging Conventions.
- The feature lists below come only from the references' READMEs and docs. The research notes, which hold only READMEs and licence texts, stay outside the repo.
- None of the reference names or brand marks appear in our code or UI.
- Third-party libraries are allowed when their licence fits Apache-2.0 (MIT, BSD, Apache, ISC, OFL for fonts). No AGPL or GPL, which rules out MuPDF and Ghostscript.
- Each workstream records every new dependency and its licence in its progress note.

## 2. Technology decision (proposed)

**TypeScript everywhere. Svelte 5 for UI. DOM, SVG and Canvas 2D for drawing. No WebGL. No Rust for now.**

Why not Rust or WASM-first:
- The Rust reference draws its *entire* interface on the GPU. That can't share our component set, brand tokens, accessibility or i18n. It is a separate app, not a Drive handler.
- One language means the same parsing code runs in the browser (viewer), in Node (agent tools such as `drive.pdf.merge`, text extraction for the Brain) and in the `ee` CLI. A Rust core would need a WASM build plus a native or WASM path on the server.
- The hard part of DOCX and PPTX is the OOXML model and layout, not raw compute. Both references are TypeScript for that reason.

Why not WebGL:
- Editing text needs the DOM. IME input, selection, spellcheck, screen readers and copy/paste all depend on it.
- Canvas 2D and SVG are already GPU-composited in every browser.
- WebGL earns its place only for truly graphic apps (image or video editing, whiteboards), which are out of scope here.

Where native speed could matter later is PDF raster and OCR. If profiling shows a real bottleneck, we add one WASM module behind a typed interface (e.g. qpdf-wasm, Apache-2.0, for encryption and linearization). It is an exception, not the architecture.

Building blocks we don't write ourselves (licences checked):
- **pdf.js** (Apache-2.0): parsing, rendering in a worker with OffscreenCanvas, text layer.
- **pdf-lib** (MIT): writing changes — page organisation, forms, annotations, metadata.
- **ProseMirror** (MIT): the DOCX editing core.
- **fflate** (MIT): ZIP. Already a dependency.
- harfbuzzjs (MIT) only if text shaping needs it.

Writing a PDF renderer from scratch is out of scope: the Rust reference still borrows its renderer from another crate.

## 3. Shared foundation (F): landed on `main` before the streams forked

This is what the streams build on. It belongs to Drive core, so changes to it go back to the orchestrator.

- **Kinds:** `src/lib/office/kinds.ts` holds `OfficeKind` (`pdf`, `docx`, `pptx`), the MIME types, the signature check (`%PDF-` / ZIP header) and `OfficeNotSupportedError`.
  - `modules/drive/preview.ts` gains `officeKind()` and two new preview kinds, `docx` and `pptx`.
  - `isRevisioned` now covers the office files. `isTextDocument` is Markdown/CSV only.
  - The Drive listings show Word and slides icons.
- **Binary saves:**
  - `drive.writeBytes(actor, id, bytes, session?)`, also available as `PUT /api/drive/files/[id]/content?session=` with the raw body and as `driveApi.writeBytes`.
  - It follows the same rules as text: edit access, the W-6 edit lock (office files take it now), one revision per editing session, and the size limit. The bytes must be the file's own format.
  - A file from before office history existed keeps its original as the first revision.
  - No schema change.
- **Reading bytes:** `driveApi.readBytes(fileId)`.
- **Edit session:** `src/lib/office/edit-session.ts` (`createOfficeEditSession`) takes the lock, heartbeats it, saves under it, and ends the session when someone takes over (`LockLostError`, `onLost(holder)`). Every viewer uses it; none talks to the lock API directly.
- **Viewer registry:** `src/lib/office/viewers.ts` holds `OFFICE_VIEWERS` (kind → lazy import of a Svelte component with `OfficeViewerProps`).
  - The file page renders the registered viewer and otherwise keeps the old preview.
  - **A stream registers its viewer with one line there when its first milestone is ready**, and that line flips the file page over.
- **Text for agents:**
  - `drive.read` on an office file calls `extractOfficeText` (`src/lib/office/text.ts`), which hands off to `src/lib/office/<kind>/text.ts`.
  - Each `text.ts` starts as a stub that throws `OfficeNotSupportedError`. The agent then gets the error "… is not supported yet", never empty text.
  - A broken file fails loudly ("could not be read: …").
- **OPC package layer:**
  - `src/lib/office/ooxml/package.ts` handles the ZIP parts, `[Content_Types].xml` and relationships with target resolution. XML editing goes through a DOM (`@xmldom/xmldom`, MIT), which works the same in Node and the browser.
  - It is lossless: untouched parts are written back byte for byte.
  - DOCX and PPTX build on it and don't fork it. A change they need goes back to the orchestrator.

Conventions found in the code: the Drive UI has inline English strings, not paraglide, so viewers follow the surrounding code. Component tests run in a real browser (`*.svelte.spec.ts`, `npm run test:components`).

## 4. Workstreams (parallel, one worktree each under `.claude/worktrees/`, disjoint files)

| Stream | Owns | Must not touch |
|---|---|---|
| `office-pdf` | `src/lib/office/pdf/**`, `modules/drive/pdf-tools.ts`, its tests | the other office folders, Drive core |
| `office-docx` | `src/lib/office/docx/**`, its tests | `ooxml/` (asks the orchestrator), `pptx/`, `pdf/`, Drive core |
| `office-pptx` | `src/lib/office/pptx/**`, its tests | `ooxml/` (asks the orchestrator), `docx/`, `pdf/`, Drive core |

Each stream may also edit its own line in `src/lib/office/viewers.ts`, its own `src/lib/office/<kind>/text.ts`, and `package.json`/`package-lock.json` (to add its dependencies; the orchestrator resolves lockfile conflicts when merging).

Every stream:

- TDD: vitest unit tests, plus component tests in a real browser.
- Fixtures we create ourselves: generated in tests, or made by us in LibreOffice or Word.
- Svelte without `$effect` for control flow.
- Strings follow the Drive's inline-English convention.
- `npm run ci:local` green before handing back.

### PDF milestones
- **P1 Viewer:**
  - continuous scroll with virtualised pages
  - thumbnails, outline/bookmarks, page labels
  - zoom (fit width/page, pinch)
  - find as you type, text selection that follows reading order, dark mode
  - `extractText`
- **P2 Organise:** rotate, delete, reorder (drag in thumbnails), insert blank or pages from another Drive PDF, extract pages, split, merge. Saved as a new revision. Agent tools: `drive.pdf.merge`, `split`, `extract_pages`, `rotate`, `delete_pages`.
- **P3 Annotate & forms:** highlight, underline, strike, notes, ink, text boxes, shapes; fill AcroForms; edit metadata/properties.
- **P4 (later, separate approval):** redaction that really removes content, password/permissions, signatures, OCR (vision model through the LLM gateway, never a direct provider call).

### DOCX milestones
- **D1 Faithful view:**
  - paginated layout: page size, margins, headers/footers, sections
  - paragraphs/runs/styles, lists/numbering, tables, images, hyperlinks
  - RTL and CJK
  - `extractText` (Markdown-ish structure for the agent)
- **D2 Editing:** ProseMirror schema mapped to and from WordprocessingML. Bold/italic/styles/lists/tables/images, undo/redo. A **lossless round-trip** keeps everything we don't model.
- **D3 Comments & tracked changes:** our own clean-room implementation. The reference keeps these under its evaluation-only licence, so this is exactly where nothing may be borrowed.
- **Later:** export to PDF, real-time co-editing. Until then the single-editor lock covers concurrent edits.

### PPTX milestones
- **S1 Faithful view:**
  - master → layout → slide inheritance, theme colours/fonts
  - preset shapes and geometry, fills/lines, pictures, tables, text boxes
  - SVG rendering, thumbnail rail, presenter mode
  - `extractText` (slide titles, body, notes)
- **S2 Editing:** edit text, move/resize shapes and pictures, add/duplicate/delete/reorder slides, undo/redo, lossless save.
- **S3 Comments:** read and write PowerPoint comments: the modern threaded comments (`p188` parts) and, read-only, legacy `p:cmLst` comments. Comments are anchored to a slide, or to a shape and a position. Includes replies, resolve and reopen, and a comments panel.
- **Later:** export to PDF, co-editing.
- Preset-shape geometry is written from the ECMA-376 text. We never copy the reference's generated tables, which are Ecma-copyrighted.

## 4b. Milestone 3 scope (owner go-ahead 2026-11-21)

- **In:** P3 (PDF annotate & forms + metadata), D3 (Word comments & tracked changes), S3 (PowerPoint comments).
- **Next wave, not in M3:**
  - Export to PDF (Word/PowerPoint → PDF) needs a server-side rendering path shared by both formats.
  - Co-editing needs a realtime backend (CRDT over a Drive channel) that replaces the single-editor lock. Each is cross-cutting and gets its own plan before any code.
- **P4** (redaction, passwords, signatures, OCR) still needs its own approval.
- Comments stay inside the file, in the format's own parts, so they travel with the download. Mirroring them into the Drive's activity or messages is a later decision.

## 5. Order and integration

1. Owner approves §2 (stack) → orchestrator lands **F** on `main`.
2. Three subagents start in parallel worktrees, one per stream, each on its milestone 1. The orchestrator reviews, merges, keeps `main` green, prunes worktrees, and logs progress in `plan/progress.md`.
3. Each stream continues to its milestone 2 after its milestone 1 merges. Milestones 3+ come back to the owner for a go-ahead.
4. Shipping a milestone: commit → `scripts/release.sh arm64` → `ee/e2e/box.sh install os.ee.localhost`. The Drive journey e2e gains one test per format (open, view, edit where shipped, save, reopen).

## 6. Not removed or changed for existing users

The current PDF `<iframe>` stays until the P1 viewer passes its e2e. The switch is announced in `plan/progress.md`. Download stays available for every format.

## 7. Excel workbooks (.xlsx): edit in place (owner request 2026-11-25)

Owner: "integrate xlsx editing functionality directly in the eigenenterprise drive." Opening an .xlsx in the Drive shows the sheet as a grid with its tabs and edits it in place; the save is a new revision of the same file. Built as a fourth office kind (`xlsx` in `src/lib/office/kinds.ts`, the viewer registry, `drive.writeBytes`, the revision panel), not a parallel viewer. Code: `src/lib/office/xlsx/`, tools `modules/drive/sheet-tools.ts`.

Decisions (taken by the implementing agent, logged here):

- **No spreadsheet library owns the file.** SheetJS CE (Apache-2.0) drops styles on write and its npm copy is stale; ExcelJS (MIT) rewrites the whole package and loses charts, pivots and extensions; HyperFormula is GPL-3.0 (excluded). Instead SpreadsheetML is read and edited on our lossless OPC layer (`ooxml/package.ts`): untouched parts stay byte for byte, edited parts keep every attribute and element they don't change (styles of untouched cells, other sheets, charts, comments, pivots, `extLst`).
- **New dependencies (all MIT):** `@borgar/fx` (formula tokenizer/parser, reference translation), `@formulajs/formulajs` (worksheet functions; pulls in `jstat` MIT and `bessel` Apache-2.0), `numfmt` (Excel number-format rendering and input parsing).
- **Formulas:** evaluated by our own evaluator over the fx AST (`calc.ts`; references, ranges, names, other sheets, Excel coercion/comparison rules) with formulajs functions where its semantics match Excel, and our own implementations where they don't (formulajs's UNIQUE/SORT/TAKE/VSTACK… differ from Excel's). Calculated (formula coverage stream, 2026-11-25): reference functions OFFSET, INDIRECT (A1 and R1C1, relative R1C1 from the formula's cell, sheet-qualified, names, table refs), INDEX returning references (`B1:INDEX(…)`), the range `:` and intersection ` ` operators, ROW()/COLUMN() of the formula's cell (`calc-refs.ts`); structured references (`Table[Col]`, `[@Col]`, `[#This Row]`, `[#Headers]`/`[#Data]`/`[#Totals]`/`[#All]`, `[[A]:[B]]`, a bare table name) resolved from the table parts; XLOOKUP (all match and search modes, returns a reference) and XMATCH; FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, RANDARRAY, TAKE, DROP, EXPAND, VSTACK, HSTACK, TOCOL, TOROW, CHOOSECOLS, CHOOSEROWS, WRAPROWS, WRAPCOLS, TEXTSPLIT, TRANSPOSE (`calc-dynamic.ts`); LET, LAMBDA (inline, in LET, as defined names), ISOMITTED, MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY. Arrays lift through operators and single-value parameters (`calc-params.ts` holds which parameters take ranges). **Three formula kinds, as the file says:** a dynamic array (`t="array"` + `cm` → XLDAPR/fDynamic metadata, `metadata.ts`) spills — the spill is recalculated (it may grow past or shrink inside Excel's last range), `#SPILL!` when blocked by content, merged cells, a table or the sheet edge, `A1#`/`ANCHORARRAY` reads it, overlapping spills are kept; a legacy Ctrl+Shift+Enter array is calculated once and fills its fixed range (single values fill it, extra cells `#N/A`); a plain formula is read the way the Excel that wrote it did — a range where one value goes is implicitly intersected with the formula's row/column, except inside SUMPRODUCT/LOOKUP/AGGREGATE/INDEX's array arguments. **Writing:** a typed formula that spills or whose meaning older Excel would read differently (decided from its structure in `calc-static.ts`, never from values) is written as a dynamic array — `t="array"`, `cm` to XLDAPR metadata (the part, relationship and content type added when missing), the spill range and spilled values on save, stale spill cells cleared; typing into a spill blocks it (`#SPILL!`), replacing the anchor clears its spill. Plain formulas stay plain. Files spell newer functions `_xlfn.` (`_xlfn._xlws.` for SORT/FILTER), LET/LAMBDA names `_xlpm.`, `A1#` as `_xlfn.ANCHORARRAY(A1)` and `@` as `_xlfn.SINGLE` (`formula-text.ts`); the grid and the tools show them as typed, and the agent's sheet reads include spilled cells. **Circular references:** without iterative calculation they keep Excel's value, marked; with `calcPr iterate="1"` the cycle is iterated up to `iterateCount` until the change is below `iterateDelta` — a cycle that doesn't settle is kept, marked. **Volatile** functions (NOW, TODAY, RAND, RANDBETWEEN, RANDARRAY, OFFSET, INDIRECT) are calculated afresh with every calculation, i.e. every change, and are stable within one. **Still not calculated (kept, marked, never guessed):** functions neither formulajs nor we provide (CELL, INFO, GETPIVOTDATA, CUBE*, RTD, WEBSERVICE, FILTERXML, IMAGE, STOCKHISTORY, GROUPBY/PIVOTBY, REGEX*, TEXTBEFORE/TEXTAFTER …), range unions (`(A1,B2)`) and INDEX over several areas, references to other workbooks, data tables (what-if), SORT/SORTBY keys with blank cells or non-ASCII text (Excel's order there is undocumented or language-dependent), UNIQUE over blanks next to 0/"", binary-search XLOOKUP/XMATCH over unsorted or repeated values, OFFSET with negative sizes, ROW() inside a multi-cell legacy array, MAP over differently sized arrays, cycles that don't settle; a function whose parameter takes ranges but is missing from `calc-params.ts` would be lifted — the table lists the ones Excel defines. Formulas use Excel's English syntax (also in the German UI).
- **Saving:** calculated values are written as the cells' cached values, `calcChain.xml` is dropped and `fullCalcOnLoad="1"` set so Excel recalculates on open. New strings go to the shared-string table. Number formats are a copy of the cell's format record with only the number format changed.
- **Moving cells** (insert/delete rows/columns) moves formula references in every sheet, defined names, merged cells, hyperlinks, conditional-format and validation ranges, array-formula ranges and column widths; shared formulas are written out per cell first. Deleted references read `Sheet!#REF!`, as in Excel. What is not moved (tables, pivot tables, drawings, comments, form controls, `extLst` features, charts that read the cells, pivot sources) is listed before the change; the grid asks, the tool needs `accept_losses: true`.
- **Sheets:** add (appended), rename (formulas, names, internal links, chart series and pivot sources follow), delete (formulas elsewhere read `#REF!`; its own parts go when nothing else uses them; the last visible sheet can't go). Hidden sheets show as dimmed tabs; chart sheets as a tab with a note.
- **Conflicts:** the editor sends `?base=<sha256>` of the content it started from (`drive.writeBytes(…, { baseSha256 })`, new optional argument); a save over a newer version is refused with `conflict` and the grid offers the newer version or a download of its own. The tools use the same check between their read and their write. The edit lock (W-6) works as for the other office editors: lock on the first change, autosave as one revision per session, Take over.
- **Registry first:** `drive.sheet_read`, `drive.sheet_write`, `drive.sheet_structure`; the browser saves through the existing `PUT /api/drive/files/[id]/content` (= `drive.save_file_bytes`). `drive.read` gives the workbook as Markdown tables.
- **Strings** are paraglide messages (`drive_sheet_*`, en + de); values show in the reader's locale (German decimal comma, WAHR/FALSCH), typed input is read in it.

Not covered yet: drawing charts/images/comments in the grid (kept, listed), editing fonts/fills/borders/alignment, sorting/filtering, freeze panes, cell comments, column resizing by drag, .xls/.xlsm/.ods, co-editing, the e2e journey step.

### 7.1 Cell formatting and sizing (2026-11-25)

Fonts (bold, italic, underline, strike, size, colour, family), fills, borders and alignment (horizontal, vertical, wrap) on the selection; column widths and row heights by dragging the header edges or typing them in the format bar. Code: `src/lib/office/xlsx/format-cells.ts` (ops), `style-records.ts` (styles.xml), `style-choices.ts` (the closed sets), `grid-style.ts` (what the grid draws), `format-toolbar.svelte`; tool `modules/drive/sheet-format-tools.ts`.

Decisions (implementing agent, logged here):

- **No library.** None edits SpreadsheetML styles losslessly (same finding as §7); styles.xml editing is ours, on the OPC layer. Untouched parts stay byte for byte.
- **Copy, change, dedupe.** A cell's new look is a copy of its `xf` with only what was edited changed; its font/fill/border record is copied the same way. An identical existing record (deep comparison; an `xf`'s `apply*` flags ignored, they don't change the look) is reused, so bolding and un-bolding returns to the original record. Records nothing points at any more stay (named styles and conditional formats may use them; Excel keeps them too).
- **Fonts:** setting a family drops the record's `scheme` (a theme font wins over the name in Excel). Underline is single (`<u/>`, as Ctrl+U). Colours are `#RRGGBB` (written ARGB); `null` is automatic.
- **Borders** are presets on the range (all, outer, inner, top, bottom, left, right, none) with a line style (default thin) and colour (default automatic, `indexed="64"`), written per cell on its own edges. The grid draws each shared edge once: a cell's own right/bottom edge, else its neighbour's facing one; empty cells next to a bordered one draw too. Automatic and black lines follow the theme's text colour unless the cell has a fill (readable in dark mode).
- **Sizes:** column width in Excel characters (0–255) as `<cols>` entries — an overlapping entry is split so its other columns keep theirs, a new entry lands before `sheetData`; a reset drops `width`/`customWidth`, or writes the sheet's default width when the entry still carries a style/hidden/outline. Row height in points (0–409) as `<row ht customHeight="1">`; a reset removes both (an empty row then goes). Setting a size shows a hidden column/row again. A drag sizes that column/row, or all selected whole columns/rows when it is one of them; the format bar sizes the selection.
- **Registry:** `drive.sheet_format` (styles / columns / rows, one revision) — the same ops as the grid. `drive.sheet_read` now returns each cell's `style` (only what differs from the plain format) and the range's custom `sizes`.
- **Keyboard:** Ctrl/Cmd+B, I, U toggle on the selection (`aria-keyshortcuts` on the buttons); toggles carry `aria-pressed`; resize handles are labelled separators, the width/height fields are the keyboard way.

Not covered by this step: diagonal borders, gradient/pattern fills, rich text runs inside a cell, autofit (double-click an edge), format painter, column/row default styles for empty cells.

### 7.2 New spreadsheet, .xlsm, .xls and .ods (2026-11-25)

Closes the ".xls/.xlsm/.ods" gap above and adds New → Spreadsheet. Decisions (implementing agent):

- **New → Spreadsheet (.xlsx)** in the Drive's New menu (en + de) is `drive.create_document` with `kind: "xlsx"` (the existing New pattern and route `POST /api/drive/documents`, no second tool): an empty workbook with one sheet "Sheet1" (`src/lib/office/xlsx/new-workbook.ts`) — content types, package relationship, workbook, a stylesheet with the default xf 0 Excel requires, the sheet; docProps left out (optional, Excel adds them). It is the file's first revision and opens in the grid. `content` with kind xlsx is refused (write cells with `drive.sheet_write`), never dropped. The sheet is always "Sheet1"; only the file name is localised.
- **.xlsm** is the same SpreadsheetML: it opens as office kind `xlsx` (extension or `application/vnd.ms-excel.sheet.macroEnabled.12`) in the same editor and tools. The OPC layer already keeps untouched parts byte for byte, so `vbaProject.bin`, its relationship and the macro-enabled main content type survive every edit (test). Macros are never run; the notes line says "kept but never run" (`macros` note).
- **.xls and .ods** are new office kinds `xls`/`ods`, read-only (`READ_ONLY_OFFICE_KINDS`): `drive.writeBytes` refuses them, so nothing ever saves BIFF/ODF in place. The browser converts the file to .xlsx (`src/lib/office/xlsx/convert.ts`, dynamic import) and shows it in the same grid, view-only, with a banner, what the copy does not keep, and **Make an editable .xlsx copy** = new tool `drive.make_xlsx_copy` (route `POST /api/drive/files/[id]/xlsx-copy`, service `makeXlsxCopy`): converted on the server, saved next to the original (a taken name gets " (2)"), the original untouched, the answer lists `not_kept`. `drive.read` converts and gives Markdown tables like .xlsx.
- **Conversion = SheetJS Community Edition 0.20.3 (Apache-2.0)** for both formats (one code path; ODF XML by hand would duplicate what SheetJS does well). Installed from the official tarball, **vendored** as `vendor/xlsx-0.20.3.tgz` (`file:` devDependency; this machine's npm forbids remote tarball installs, and SheetJS recommends vendoring) — never the stale npm `xlsx@0.18.x` (CVE-2023-30533). A devDependency, so adapter-node bundles it into the server build (the release's `npm ci --omit=dev` needs no tarball); the Dockerfile copies `vendor/` before its `npm ci`s. Loaded only when an .xls/.ods is opened, read or copied — never in the main bundle. SheetJS only reads the legacy file; the .xlsx it writes is checked by our own reader before anyone sees it, and from then on our OPC editor owns the copy.
- **What the copy keeps / doesn't:** keeps sheets (order; ODS hidden sheets too — SheetJS doesn't read ODF visibility, so we read `table:display` from content.xml ourselves), values, formulas in Excel syntax, number formats, merges, column widths, names. Not kept (listed in the UI and the tool answer, a fixed per-format list rather than per-file detection): cell formatting (fonts, fills, borders, alignment — SheetJS CE doesn't write styles), charts/pictures/drawings, conditional formatting, data validation, pivot tables, macros.
- **Fixtures:** the .ods is hand-written ODF; the .xls is SheetJS BIFF8 with a real FORMULA record patched in (SheetJS writes no formulas to BIFF), so formula import is tested on genuine BIFF.

Not covered: per-file detection of what a conversion loses; .xlsb / .xltx / .xltm; Strict OOXML.
