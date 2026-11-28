# Artifacts: pages and slide decks the assistant builds in Drive (2026-11-28)

Wishes 7478dbe4 (member + owner: "work on decks like in Claude"; owner: "something like claude
artifacts — files stored in the drive and editable from agents") and a4a5a3ad (free design:
layout, illustration, montages, a carousel with its own layout per slide).

## What it is

An **artifact** is an HTML file in Drive that the assistant (or a co-worker, or `ee`) writes and a
person sees rendered:

- a **page**: `<name>.html`, any HTML document (one-pager, layout, mockup, carousel);
- a **deck**: `<name>.deck.html`, slides on 1920×1080 stages, scaled to the frame, printed one
  slide per page.

When the assistant creates or changes one, it opens **beside the chat** and reloads on every
change. Export PDF saves `<name>.pdf` next to it.

## Shape

```
artifacts.create / update / read / export_pdf   (modules/drive/artifact-tools.ts, namespace "artifacts", module drive)
   └ pure format: modules/drive/artifact.ts  (deck layout, slide markers, slide ops, find/replace)
   └ Drive service: upload (create), writeHtml (new revision, base-sha conflict check), readFile
engine: tool.finished carries artifact { fileId } for artifacts.create/update (src/lib/tool-steps/artifact.ts)
chat:   AssistantChat.artifact (artifact-panel-state.svelte.ts) → GET /api/drive/artifacts/[id] → fresh view URL
        → <iframe sandbox="allow-scripts"> from /api/drive/view/<token>/… (the existing sandboxed HTML view)
Export PDF button → POST /api/drive/artifacts/[id]/pdf (= artifacts.export_pdf)
```

## Decisions

- **Reuse Drive's HTML view, no new renderer.** HTML in Drive already renders in a sandboxed frame
  (opaque origin, CSP `sandbox allow-scripts`, no same-origin, so no session or cookies; a 1-hour
  view token in the path). Artifacts are plain HTML files, so sharing, revisions, trash, search
  and the Drive file page all just work.
- **The kind is the file name** (`.deck.html` vs `.html`), a format fact like every Drive preview.
- **HTML files now keep revisions** (`isRevisioned`), so every artifact change can be restored.
  Additive: uploads of any `.html` now also create revisions.
- **Deck format:** our own small template, not reveal.js or another library (no deps). Slides sit
  between `<!--ee-slide-->` markers inside `<!--ee-deck-->`, so one slide can be replaced,
  inserted, moved or deleted without rewriting the deck. Slides may be HTML or Markdown (rendered
  and sanitized with the Drive's Markdown renderer at write time). A deck whose markers were edited
  away refuses slide ops and says to rewrite it whole.
- **Targeted edits are exact find/replace** (each `find` must occur once; nothing changes on a miss),
  checked against the content read (base sha256): a concurrent change is a `conflict`, never a
  silent overwrite.
- **The view URL is for people only.** `artifacts.read` with `view_url` refuses an agent principal:
  the URL is a 1-hour bearer for the person, it never goes into an agent's context.
- **Writes are mutate-class, `approvalRisk: internal`**, gated by the company's approval mode like
  `drive.write_text` (in `ask` mode the person approves the first create/update).
- **UI routes call the Drive service directly** (the Drive's convention), the registry tool shares
  the same function (`exportArtifactPdf`, `artifactViewFor`). Parity: `/api/drive/artifacts/[id]/pdf
  POST` → `artifacts.export_pdf`.
- **PDF export renders offline**: headless Chromium (the existing `EE_CAP_CHROMIUM` capability), all
  network blocked: only what is inside the artifact (inline CSS, data: images) prints. A box
  without Chromium fails loud ("needs a browser on the server").
- **PPTX export: not built.** Writing a real .pptx from arbitrary HTML needs a layout engine or a
  heavy library (pptxgenjs + HTML→shapes); a picture-per-slide .pptx would be uneditable. Logged as
  a follow-up; PDF covers sending a deck.

## What was missing (wish check)

- **Assistant reading PDF/Word from Drive:** already there. `drive.read` extracts PDF, Word and
  PowerPoint text.
- **Chat attachments:** existed for PDF, images and text. **Word (.docx) and PowerPoint (.pptx)
  were refused.** Added: detected by the zip's own main part (`word/document.xml`,
  `ppt/presentation.xml`), read locally with the same extractor as `drive.read` (no model call).
- **Rendered slide preview next to the chat:** missing. Added (the artifact panel).

## Open / next

- PPTX export (above).
- The panel opens live only; reopening an old conversation does not reopen its artifact (the
  stored step keeps no file id yet).
- An Export PDF button on the Drive file page for `.html` files (today: the chat panel, the CLI
  `ee tool run artifacts.export_pdf`, the agent).
- Images from Drive inside an artifact render in the view (relative paths below its folder) but not
  in the PDF (network blocked); inline them as data: URLs for print.
