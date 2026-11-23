# Memory: one door in, one page out — concept for discussion

**Status:** DRAFT, not approved. Owner: "Yes, draft concept" (2026-11-23).
**Sources:** contribute fba4abf3 ("Capture soll weg"), 11f05e24 (one input bar, token cost?), 3668d181 (Notes vs Capture, Tasks vs Projects), b92e6ba5 (handover page). All are from ee-one.
**Builds on:** `plan/phase-company-brain.md` §2 (the four layers), §4 (visibility), §5 (decision shape picks the engine), CB2 (Jev in the gateway), CB14 (Memory onto the dial), CB15 (background runs).

## 1. What people are telling us

Memory makes people do the brain's job twice:

- **On the way in, they sort.** There are four doors:
  - the Ask bar, where the chat model picks the tool;
  - Capture, which makes a thought and runs one LLM "interpret" call;
  - Notes, a plain document with no model;
  - "Add a task", a thought with its category fixed.

  The person has to pick a door before saying anything. Ony: *"Bei Claude kann ich alles in eine Zeile tippen … es nimmt mir die Entscheidung ab."*
- **The tabs show our tables, not their work.** "Note vs Capture" is the difference between `text_file` (stored as written, no graph) and `thought` (enriched, embedded, linked into the graph). That's an implementation detail leaking into the product. Nobody can explain it because it isn't a user concept.
- **Nothing comes out the other side.** Files, calls, notes and tasks go in. What the brain makes of them is seen only by the person who happens to ask. There's no page where the current state stands for the team (b92e6ba5). That breaks the "working out loud" north star (§1).

## 2. The model

```
IN    one door ──► Jev routes (closed set) ──► the existing pipelines
                   question · remember · task · document · reminder · status update
HOLD  Memory = what the brain holds:  Tasks · Projects · Documents · Reminders · What the brain knows
OUT   Status pages the brain keeps current, readable by the team; entries can be assigned → "Needs you"
```

### 2.1 In: one door

- **The Ask bar becomes the only place to type or speak into the brain.** It's on every page and already takes voice. There's no choice to make first.
- **Routing is a closed-set decision, so it goes to Jev, not the LLM** (§5):
  - "Is this a question, something to remember, a task, a document, a reminder, or a status update?"
  - plus "Which project?" from the person's open projects, one of N.
- **The model's choice shows as a chip under the input,** e.g. "Saved as task in *Pitch Deck* · change". One tap corrects it, and low confidence asks instead of guessing (§5). The correction is logged for Jev's shadow evaluation.
- **Only a question opens a chat reply.** Everything else is filed, with no LLM turn.

**What it costs (Ony's question).** Today one capture costs about 6 chat calls and 2 embedding calls. A task that names a project costs 10 or more, because category, project identity, project assignment and project detection are each an LLM call. With routing on Jev:

| Step | Today | One door |
|---|---|---|
| Which kind of input | LLM interpret call (Capture box) or the chat model's tool choice (Ask bar) | Jev, about $0.000014 |
| Which project | 2–3 LLM calls (identity, assignment, detection) | Jev, one of N |
| Category in enrichment | LLM (with a retry) | Jev |
| Entities, relations, embedding | LLM + embedding | unchanged (new structure and vectors) |

The one door is cheaper than the four doors today, because the decisions move off the LLM. The LLM keeps only work that writes something: cleaning up text and extracting entities.

### 2.2 Hold: Memory shows what the brain holds

| Today | Proposed | Why |
|---|---|---|
| Overview | (removed) | The open-task list is the Tasks tab's "today" view |
| Capture | **What the brain knows** | Read-only: everything the brain took in, from where, and its status (indexed / pending / failed + Retry). The input box goes away (the Ask bar replaces it). This also answers 30a8d920 part 2, "see what the brain absorbed". |
| Notes | **Documents** | A text you write and keep as written. One line on the page: "Kept as you wrote it. The brain reads it, but doesn't rewrite it." |
| Tasks | Tasks | Unchanged. One line: "One step someone does." |
| Projects | Projects | Unchanged. One line: "An outcome with several steps." Tasks and projects aren't redundant: a project groups tasks. |
| Reminders | Reminders | Unchanged |

**Removal, announced:** Capture's input page and the Overview tab go away. Nothing anyone captured is lost: thoughts stay and are listed under "What the brain knows". The 5-second auto-accept confirmation modal is replaced by the chip.

### 2.3 Out: Status pages

- **A Status page per person, and one per project:**
  - newest first, one entry per topic;
  - each entry has a date, a topic, one sentence, a status (**decision needed** · **in progress** · **for info**) and a link to the detailed document, task or call.
- **The brain keeps it current.** When new state appears (a file, a call recap, a note, a closed task), a CB15 background run acting as the page's owner runs two steps:
  - Jev decides whether this changes the state of a topic, which topic it belongs to, which status it has, and who it could be assigned to;
  - the LLM then writes only the one sentence.
- **The owner edits, and everyone in the company reads.** The default is the company, because this page is how the company works out loud; any entry can be made private.
- **Visibility follows §4:**
  - entries are built only from content the page's readers may see;
  - a private thought feeds an entry only after its owner's OK ("Put this on your status page?");
  - the summary is built for each audience separately, never across audiences.
- **Assigning:**
  - the brain suggests an assignee, or the owner picks one;
  - an assigned entry appears in that person's "Needs you" and is an `assigned_task` underneath;
  - an unassigned entry stays as info. Nothing forces an assignment.
- **The person still types into the one door,** e.g. "Note for Alex: pricing is decided, $40". Jev routes it as a status update.
- **Registry first:** `status.list`, `status.get`, `status.add_entry`, `status.update_entry`, `status.assign`, so the CLI, the agent and co-workers can read and write it too. AI co-workers (`plan/phase-ai-coworkers.md`) get a Status page like anyone else.

## 3. Order

1. **CB2 (Jev in the gateway) first.** Without it, the one door would be LLM routing, which breaks the maxim and costs more.
2. **M1: one door.** Jev routing in the Ask bar, the chip with "change", corrections logged. Shadow mode next to today's paths first.
3. **M2: Memory tabs.** Capture becomes "What the brain knows", Notes become Documents, Overview is removed, and each page gets its one-line explanation.
   - It doesn't depend on M1 except for removing the Capture input. The renames and explanations could ship this week.
4. **M3: Status pages.** Depends on CB15 (background runs on events).

## 4. Decisions for the owner

1. **Is the Ask bar the one door, with Capture's input and Overview removed?**
2. **Status pages:** per person and per project (proposed), or per person only? Is "visible to the company, any entry can be made private" the right default?
3. **Names:** "Status" / "Stand", "What the brain knows" / "Was die Brain weiß", "Documents" / "Dokumente".
4. **Ship M2's renames and explanations now,** ahead of CB2?
