# Plugin boundary: every sidebar entry a real plugin (draft, plan next)

**Owner decisions (2026-11-12):** every sidebar entry is a plugin (Messages, Assistant/Chat,
Calls, Website, Email, Brand, Memory, Drive, Contacts, Calendar …) — the specs intend it and it
stays that way. Official plugins are never removed or altered, only deactivated. A company's own
plugin is always added alongside; it may implement the same contract as an official one, which the
owner then deactivates. A plugin a person switched off is never switched back on by the assistant.
The owner asked for this plan before any move ("Yes, plan it next").

## Where the code stands (W6 report, round 4)
- **Assistant/Chat:** no module. Shell top bar + panel (`src/lib/components/assistant/`, `src/routes/(nucleus)/assistant/`); its agent tools sit in the internal `modules/orchestrator`, so today it is core and can't be switched off.
- **Memory:** `modules/memory/` holds only the manifest and tools; ~70 implementation files in `src/lib/server/memory/`, pages in `src/routes/(nucleus)/m/memory/`.
- **Partly in core:** Messages UI (`src/lib/messages/`), Calls UI (`src/lib/calls/`), Drive UI (`src/lib/components/drive/`), Brand server code (`src/lib/server/brand/`), Website server code (`src/lib/server/website/`). Every plugin's pages live under `src/routes/(nucleus)/…` (SvelteKit's file routing).
- Settings → Plugins (round 4 W6) switches plugins through the kernel; W7 makes "off" really off (pages, APIs, jobs, agent).

## To decide in this plan (draft questions)
1. **Folder rule:** a plugin's server code, UI components, tools, migrations and specs live under `modules/<id>/`; `src/routes/…` keeps only thin route files that import from the plugin. Boundary spec: core never imports a plugin; plugins talk through kernel ports/tools/events only (`modules/boundaries.spec.ts` exists — extend it to UI + server code).
2. **Assistant as a plugin:** the top bar, panel and conversation pages move into `modules/assistant`; the shell gets an empty slot when it's off. What stays core: the kernel registry, approvals, the durable agent engine (other plugins' agents use it)?
3. **Memory:** move `src/lib/server/memory/**` into `modules/memory/`; who else imports it today (grounding, onboarding, recap) must go through ports.
4. **Contract per plugin** (for "own plugin with the same contract"): tools + their schemas, events, data folders, UI slots, as in `plan/phase-extensions.md` §2. Versioned.
5. **Order:** one plugin per slice, smallest first, each green on its own (unit + e2e of that plugin).

Not started. Next: inventory of imports across the boundary (a read-only pass), then the slice list for approval.
