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
- **Formulas:** evaluated by our own evaluator over the fx AST (`calc.ts`; references, ranges, names, other sheets, Excel coercion/comparison rules) with formulajs functions where its semantics match Excel, and our own implementations where they don't (formulajs's UNIQUE/SORT/TAKE/VSTACK… differ from Excel's). Calculated (formula coverage stream, 2026-11-25): reference functions OFFSET, INDIRECT (A1 and R1C1, relative R1C1 from the formula's cell, sheet-qualified, names, table refs), INDEX returning references (`B1:INDEX(…)`), the range `:` and intersection ` ` operators, ROW()/COLUMN() of the formula's cell (`calc-refs.ts`); structured references (`Table[Col]`, `[@Col]`, `[#This Row]`, `[#Headers]`/`[#Data]`/`[#Totals]`/`[#All]`, `[[A]:[B]]`, a bare table name) resolved from the table parts; XLOOKUP (all match and search modes, returns a reference) and XMATCH; FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, RANDARRAY, TAKE, DROP, EXPAND, VSTACK, HSTACK, TOCOL, TOROW, CHOOSECOLS, CHOOSEROWS, WRAPROWS, WRAPCOLS, TEXTSPLIT, TRANSPOSE (`calc-dynamic.ts`); LET, LAMBDA (inline, in LET, as defined names), ISOMITTED, MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY. Added by the pivots/tables/formulas stream (2026-11-25, §7.6): TEXTBEFORE, TEXTAFTER, REGEXTEST, REGEXEXTRACT, REGEXREPLACE, ARRAYTOTEXT, VALUETOTEXT, ENCODEURL, ADDRESS (`calc-text.ts`; Excel's regexes are PCRE2 — a pattern is run on JS RegExp only where the two agree, the constructs that differ are refused); GROUPBY, PIVOTBY, PERCENTOF (`calc-groupby.ts`; eta-reduced SUM/AVERAGE/COUNT… or a LAMBDA); the deterministic parts of CELL and INFO, SHEET, SHEETS, ISFORMULA, FORMULATEXT, TRIMRANGE (`calc-info.ts`); SUBTOTAL and AGGREGATE with hidden/filtered rows, nested SUBTOTALs and errors as documented, MDETERM, MINVERSE (`calc-agg.ts`); range unions `(A1,B2)` as multi-area references (aggregates, AREAS, INDEX's area_num, SUBTOTAL/AGGREGATE, TEXTJOIN/CONCAT/AND/OR); GETPIVOTDATA (from the PivotTable's cache records — what it shows until the next Refresh); a sweep of Microsoft's function list: the bond/coupon/depreciation functions formulajs lacks (ACCRINTM, COUP*, DURATION, MDURATION, INTRATE, RECEIVED, PRICE, PRICEMAT, YIELD, YIELDDISC, YIELDMAT, VDB, AMORLINC, AMORDEGRC, ODDF*/ODDL*; `calc-fin.ts`), T.DIST and TYPE where formulajs differs from Excel, and the compatibility names (CHIDIST, CHIINV, FDIST, FINV, ECMA.CEILING …) mapped to their newer functions. `calc-params.ts` was audited against the list (range/array parameters of the aggregates, statistics, financial and database functions, GROUPBY/PIVOTBY …); a unit test fails when any function the engine can evaluate — ours, the dynamic-array ones, every formulajs export — is not classified there. Arrays lift through operators and single-value parameters (`calc-params.ts` holds which parameters take ranges). **Three formula kinds, as the file says:** a dynamic array (`t="array"` + `cm` → XLDAPR/fDynamic metadata, `metadata.ts`) spills — the spill is recalculated (it may grow past or shrink inside Excel's last range), `#SPILL!` when blocked by content, merged cells, a table or the sheet edge, `A1#`/`ANCHORARRAY` reads it, overlapping spills are kept; a legacy Ctrl+Shift+Enter array is calculated once and fills its fixed range (single values fill it, extra cells `#N/A`); a plain formula is read the way the Excel that wrote it did — a range where one value goes is implicitly intersected with the formula's row/column, except inside SUMPRODUCT/LOOKUP/AGGREGATE/INDEX's array arguments. **Writing:** a typed formula that spills or whose meaning older Excel would read differently (decided from its structure in `calc-static.ts`, never from values) is written as a dynamic array — `t="array"`, `cm` to XLDAPR metadata (the part, relationship and content type added when missing), the spill range and spilled values on save, stale spill cells cleared; typing into a spill blocks it (`#SPILL!`), replacing the anchor clears its spill. Plain formulas stay plain. Files spell newer functions `_xlfn.` (`_xlfn._xlws.` for SORT/FILTER), LET/LAMBDA names `_xlpm.`, `A1#` as `_xlfn.ANCHORARRAY(A1)` and `@` as `_xlfn.SINGLE` (`formula-text.ts`); the grid and the tools show them as typed, and the agent's sheet reads include spilled cells. **Circular references:** without iterative calculation they keep Excel's value, marked; with `calcPr iterate="1"` the cycle is iterated up to `iterateCount` until the change is below `iterateDelta` — a cycle that doesn't settle is kept, marked. **Volatile** functions (NOW, TODAY, RAND, RANDBETWEEN, RANDARRAY, OFFSET, INDIRECT) are calculated afresh with every calculation, i.e. every change, and are stable within one. **Still not calculated (kept, marked, never guessed):** functions that need something outside the file (CUBE*, RTD, WEBSERVICE, FILTERXML, IMAGE, STOCKHISTORY, FIELDVALUE), CELL/INFO types that describe the computer, the file's location or the screen font (CELL "filename"/"width"/"color" of another sheet's address…, INFO "directory"/"osversion"/"system"…), regex constructs where PCRE2 and JS differ (and case-insensitive matching of non-ASCII text), GROUPBY/PIVOTBY cases Microsoft doesn't document (guessed headers, subtotals over several fields, several column fields with field headers, totals relative to parents), GETPIVOTDATA of a PivotTable saved without its records, a union where a single range goes (or over several sheets), references to other workbooks, data tables (what-if), SORT/SORTBY keys with blank cells or non-ASCII text (Excel's order there is undocumented or language-dependent), UNIQUE over blanks next to 0/"", binary-search XLOOKUP/XMATCH over unsorted or repeated values, OFFSET with negative sizes, ROW() inside a multi-cell legacy array, MAP over differently sized arrays, cycles that don't settle; a function whose parameter takes ranges but is missing from `calc-params.ts` would be lifted — the table lists the ones Excel defines. Formulas use Excel's English syntax (also in the German UI).
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

### 7.3 Sort, filter, freeze panes (2026-11-25)

Built as three more sheet operations on the same lossless layer (`src/lib/office/xlsx/sort.ts`, `filter.ts`, `panes.ts`; `sort_range`, `set_autofilter`, `filter_column`, `freeze_panes` in `ops.ts`), each one undoable transaction; only the sheet's XML (and, for a filter, the workbook's `_xlnm._FilterDatabase` name) changes, every other part stays byte for byte. No new dependency: `@borgar/fx` (already in) moves formulas.

Decisions (taken by the implementing agent, logged here):

- **Sort = Excel's Data ▸ Sort.** Rows of the range (below the header row when `header`) are ordered by 1–64 keys; whole `<c>` elements move (value, style, formula, metadata), so formats go with their rows. A moved formula is translated like a cut-and-paste (relative references follow, absolute stay; a reference pushed above row 1 / left of A becomes `#REF!`, fx `wrapEdges: false`). References from elsewhere into the range are not rewritten — as in Excel. Shared formulas are written out per cell first. Hidden rows stay where they are (Excel doesn't move them). Single-cell hyperlinks move with their cell; stale `sortState` elements over the range are dropped.
- **Sort order:** numbers < text (case-insensitive, `Intl.Collator('en', { sensitivity: 'accent' })`) < FALSE < TRUE < errors (kept in place among themselves); blanks always last, also descending. Excel's "ignore hyphens/apostrophes" word-sort nuance is not copied.
- **Refused / named before a sort:** merged cells or array/data-table formulas in the range are refused (Excel refuses too). Tables overlapping the range, pictures anchored in it, comments and threaded comments on its cells don't move: they are named as losses (same confirm dialog as structure changes; the tool needs `accept_losses`).
- **Quick sort's range** (toolbar A→Z / Z→A, Sort… dialog) is picked as Excel does: the filter range when the active cell is in it (header row), a multi-cell selection as is (no header), or the current region around a single cell with the header guessed from kinds and formats (first row all text, and the next row differs in kind or format — a structural rule, no string meaning). The dialog lets the person override the header.
- **AutoFilter:** `<autoFilter ref>` placed in CT_Worksheet order plus Excel's hidden `_xlnm._FilterDatabase` defined name (written, removed; insert/delete rows already move both). A single cell turns the filter on for its current region. Value filters are `filterColumn/filters` with `filter val` = the shown text in Excel's English formatting, matched ignoring case, `blank="1"` for empties; rows that fail are `row hidden="1"`, turning the filter off or clearing a column shows them again. Criteria this editor can't evaluate (custom, top 10, dynamic, colour, icon, date groups) are read as "kept" and left exactly as written; rows Excel hid for them stay hidden when another column changes. A filter overlapping a table is refused (tables filter themselves; table filters are edited as the table's own, §7.6).
- **Freeze panes** on the sheet's first `sheetView`: `pane xSplit/ySplit topLeftCell activePane state="frozen"` plus an empty `selection` per pane, as Excel writes it; unfreeze removes the pane and the per-pane selections and nothing else. Reading accepts `frozen` and `frozenSplit`; a view saved scrolled (`sheetView topLeftCell`) counts its frozen rows from the top of the sheet, since the grid freezes from row 1.
- **Grid:** frozen rows/columns are sticky panes (four quadrants drawn from one snippet, the freeze line drawn like Excel's); the AutoFilter puts a drop-down button in each header cell (Alt+↓ opens it) with Excel's menu: sort by this column, search, (Select all), values with counts, (Blanks), OK / Clear filter; view-only people see the state read-only. The tab bar says "n of m rows shown".
- **Registry:** `drive.sheet_sort`, `drive.sheet_filter` (on/off, per-column values), `drive.sheet_freeze`; `drive.sheet_read`'s sheet list now carries each sheet's `filter` and `frozen`. All three wait on the approval mode like the other sheet writes.

Not covered yet: custom/number/date filter conditions and colour/icon filters as editable rules (kept and shown as "set in Excel"), sorting by colour or custom lists, case-sensitive and left-to-right sorts, split (non-frozen) panes. (Table filters and sorts: §7.6.)

### 7.4 Charts (2026-11-25)

Full clean-room DrawingML chart read/write (`src/lib/office/xlsx/chart-read.ts`, `chart-write.ts`, `chart-anchor.ts`, `chart-color.ts`, `chart-data.ts`, `chart-ops.ts`), zero-dependency SVG mark renderer (`chart-layout.ts`), UI (`chart-view.svelte`, `chart-overlay.svelte`, `chart-dialog.svelte`), and registry tools (`modules/drive/sheet-chart-tools.ts`).

Decisions (implementing agent, logged here):

- **Zero-dependency SVG mark renderer (no ECharts / charting package).** `chart-layout.ts` lays out all marks (`rect`, `path`, `circle`, `line`, `text`) from a pure scene model (`layoutChart`) so the exact geometry is unit-tested in Node and painted directly as inline `<svg>` in `chart-view.svelte`. No external charting library, no GPL dependencies, no bundle bloat, and theme/locale integration stays native.
- **Lossless OPC + non-chart anchor preservation.** Charts live in `/xl/charts/chartN.xml` anchored via `xdr:graphicFrame` in `/xl/drawings/drawingN.xml` (or `absoluteAnchor` on chart sheets). Untouched charts stay byte-for-byte; pictures, shapes, and other non-chart anchors in shared drawing parts are left untouched when charts are created, moved, shifted, sorted, or deleted.
- **Live data resolution with marked cache fallback.** Series cell formulas (`c:f` — sheet-qualified ranges, unions, defined names) resolve live against the workbook's `calc` engine (honouring `plotVisOnly` hidden rows/columns and `dispBlanksAs`). When a reference cannot be resolved (external workbook `[1]...`, missing sheet, `#REF!`), the renderer falls back to `c:numCache`/`c:strCache` and marks the series/chart as `cached` (never guessed).
- **Supported types and variants:** column and bar (`clustered`, `stacked`, `percentStacked`), line (with/without markers, `standard`, `stacked`, `percentStacked`, smooth), area (`standard`, `stacked`, `percentStacked`), pie (slice angles, `varyColors`, `%` labels), doughnut (multi-ring, `holeSize`), scatter (`lineMarker`, `marker`, `smoothMarker`, `line`, `none`), bubble, radar (`marker`, `standard`, `filled`), stock (HLC/OHLC), combo charts (multiple plot areas + secondary right value axis), and full-tab chart sheets (`chartsheet`). Unsupported chart groups (e.g. `surfaceChart`, `ofPieChart`) are named and kept intact on save.
- **Structure ops & sort integration:** inserting or deleting rows/columns shifts chart `c:f` series references across the workbook and moves/resizes `twoCell`/`oneCell` anchors (`shiftCharts`), so charts are no longer reported as losses on row/column structure changes (`editAs="absolute"` stays fixed; pictures/shapes remain reported). Sorting (`sort_range`) ignores chart anchors in `sortLosses`, moves chart anchors anchored in the sorted body, and leaves series references as they are (Excel's sort doesn't rewrite references into the range), so charts plot the sorted cells live.
- **UI & registry parity:** anchored charts render over `sheet-grid.svelte` (below sticky headers and frozen panes), chart sheets render full-tab, cells live-update charts as you type, drag/8-handle resize commits `chart_move`, `chart-dialog.svelte` creates from selection (default column) or edits (type, grouping, title, legend, series ranges/types/secondary axis, axis titles/scale/gridlines, data labels, markers, colours), and `drive.sheet_chart_list`, `drive.sheet_chart_create`, `drive.sheet_chart_update`, `drive.sheet_chart_delete` (+ chart summaries in `drive.sheet_read`) expose full parity to agents (`drive.sheet_chart_*` writes wait on approval mode).

Not covered yet: 3-D perspective projection (3-D groups render as their flat equivalent), surface/ofPie/treemap/sunburst (`cx:chart`) rendering, trendline/error-bar visual marks (kept in XML on edit/save), gradient fills (first stop colour used).

### 7.6 Pivot tables, Excel tables and the remaining formulas (2026-11-25)

Owner: "take some open source repo like univer to clean-room code an xlsx editor that is feature complete." This stream: PivotTables, Excel tables (ListObjects) and the formulas still listed as not calculated (the Formulas bullet above). Clean room: Microsoft's documentation of Excel and Univer's documented behaviour are the spec; no source copied, no new dependency. Code: `src/lib/office/xlsx/tables.ts`, `pivot.ts`, `pivot-calc.ts`, `calc-text.ts`, `calc-groupby.ts`, `calc-info.ts`, `calc-agg.ts`, `calc-fin.ts`; UI `table-dialog.svelte`, `table-bar.svelte`, `pivot-fields.svelte`; tools `modules/drive/sheet-pivot-table-tools.ts`.

Decisions (taken by the implementing agent, logged here):

- **Excel tables** are `xl/tables/tableN.xml` parts (content type, the sheet's relationship and `tableParts`), written as Excel writes them: unique `id` across the workbook, `name`/`displayName` (Excel's naming rules; Table1, Table2 … by default), `ref`, `autoFilter`, `tableColumns` with unique names (blank or repeated headers become Column1 / Name2, as Excel does), `tableStyleInfo`. **Create** (Ctrl+T or Ctrl+L, the Table button, `drive.sheet_table_create`): the selection or the current region; "My table has headers" off pushes the data one row down and writes Column1…n. Overlapping another table, a merged cell or a PivotTable is refused. **Styles**: Excel's built-in names (`TableStyleLight1…21`, `Medium1…28`, `Dark1…11`); the grid draws the common presets' palette (header, banding, total row) under the cell's own format — the file keeps only the name, as Excel's does. **Style options**: header row (off → `headerRowCount="0"`), total row (on → `totalsRowCount="1"`, a row with `SUBTOTAL(109,[Col])` in the last column and "Total" in the first, per column sum/count/average/min/max/countNums/stdDev/var/custom as `totalsRowFunction` + the matching SUBTOTAL formula), banded rows/columns, first/last column, filter button. **Auto-expand**: a value typed in the row just below (when there is no total row) or the column just right of a table grows it, naming a new column from the header typed; a total row stops it growing downwards. **Resize** (`ref`), **rename** (structured references in every formula and name follow), **convert to range** (`delete_table`, default mode: values and formats stay, structured references become A1 references) or delete the cells.
- **Sort and filter on tables** (the sort/filter stream refused them): a table's drop-downs are its own `autoFilter` in the table part, so `filter_column` takes `table` and writes there, hiding rows like the sheet filter; the grid shows the drop-downs of the sheet filter and every table, `drive.sheet_filter` takes `table`. A sort of a table's range keeps the header and total row in place, writes the table's `sortState`, and doesn't count the table as a loss.
- **PivotTables** are read from their `pivotTableDefinition` + cache (`pivotCacheDefinition` + `pivotCacheRecords`, workbook `pivotCaches`). Existing ones are cells already; the grid draws them with their style's look. **Refresh** recomputes from the source range or table (`pivot-calc.ts`: row/column fields nested, page filters with one selected item, hidden items, several value fields, sum/count/average/min/max/product/countNums/stdDev/var, subtotals, row/column grand totals, Excel's item order — numbers, then text ignoring case) and rewrites the cache (shared items, records) and the rendered cells. **Create** from the selection (new sheet "PivotTable1…", or a cell of this sheet), **edit fields** in the field list (tick → Rows, drag between Filters/Columns/Rows/Values, or the keyboard "move to" lists; value summarisation; the filter's item), **delete** (cells cleared, the cache removed when no other PivotTable uses it). Written with `refreshOnLoad="1"` so Excel rebuilds it on open from the same source; the XML is in schema order with counts. Not built: calculated fields/items, grouping (dates, number ranges), "show values as", value filters, compact/outline/tabular form switching (the compact layout Excel defaults to is written), PivotCharts, slicers, external/OLAP sources — such parts are kept as they are; refreshing a PivotTable that uses them is refused rather than dropping them.
- **GETPIVOTDATA** answers from the PivotTable's cache (what it shows until Refresh, as in Excel), with data field and field/item pairs; `#REF!` when the reference isn't in a PivotTable or the field/item pairs name no value it shows.
- **Registry first:** `drive.sheet_table_create/update/delete`, `drive.sheet_pivot_create/update/refresh/delete`; `drive.sheet_read`'s sheet list carries each sheet's `tables` and `pivots`. All wait on the approval mode like the other sheet writes. The workbook notes no longer list tables and PivotTables as "not shown".
- **Strings** en + de (`drive_sheet_table_*`, `drive_sheet_pivot_*`).

Not covered yet: custom table styles from `tableStyles` drawn in the grid (kept, the name shown), the table total row's drop-down in the grid (set per column with `drive.sheet_table_update` or by typing), the PivotTable items' own drop-downs in the grid (the field list's filter item and `hidden_items` do it), the PivotTable features named above.
