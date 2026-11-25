# Handover — the brain keeps the current state (concept + v1)

Wish b92e6ba5 (Ony): chat is not re-read, Drive holds raw files. Missing is one page where
the company brain says **where things stand**, readable by everyone. Today Ony writes
"Übergabe an Alex" by hand and it goes stale.

## 1. Shape

A **handover** is a page owned by one member, for a **person** (subject: "Handover to Alex")
or for a **topic** (no subject). It holds **one entry per topic**:

| field | meaning |
|---|---|
| day | the day the entry speaks for (changes when the entry changes) |
| topic | the identity of the entry — one per handover (case/outer spaces aside) |
| sentence | one sentence: where it stands, observed (no evaluation of people) |
| status | `decision_needed` · `in_progress` · `for_info` |
| link | app path (`/m/…`) or http(s) URL to the detail document/item |
| assignee | optional member; null = information |

Entries are shown newest first. Everyone in the company reads every handover (no per-item
sharing — that is the point). Only the owner writes: themself, their assistant on their word,
or the brain's upkeep acting for them.

## 2. Decisions (v1)

- **Company-level tables, no RLS** (`handovers`, `handover_entries`, migration 0184), like
  assigned tasks: access is the service's (`src/lib/server/memory/handover/service.ts`).
  A handover is not Memory: nothing in it reads anyone's private Memory; the brain only puts
  in what the owner's own call hands it.
- **Lives in Memory's area** (`/m/memory/handover`, tab "Handover"/"Übergabe"), namespace
  `handover.*` owned by the memory module.
- **One entry per topic** is structural: a unique index on `(handover_id, lower(btrim(topic)))`.
  A second add on the same topic is a conflict pointing to `handover.update_entry`.
- **Assigning reuses assigned tasks** (0158): `handover.assign_entry` gives the member an
  assigned task from the owner — title "Handover: <topic>", context = sentence, status,
  detail link and the way back (`/m/memory/handover#entry-<id>`). So it lands in their
  **Needs you**, Memory › Tasks, push + email, and an AI co-worker gets its turn. One open
  assignment per entry; a new one waits until the earlier task is done.
- **Removing an entry** leaves an assigned task with its assignee (it is theirs now).
- **Decision shape** (`handover.draft_entry`, `modules/memory/handover-upkeep.ts`):
  - status (closed set of 3) → Jev, kind `memory.handover_status`, **enforced** from the
    start: there is no current judge and an entry needs a status. Below confidence 0.6 the
    owner is asked in Needs you and the draft is `pending` (call again after the answer;
    the same input finds the answer). A status the owner gives skips Jev.
  - sentence (new text) → gateway LLM (`llmChatCompletion`, JSON `{sentence}`, contentOrigin
    `memory`, company provider, billed to the owner); it only writes.
  - which entry → structure: the entry on that topic, else a new one.

## 3. Tools (registry first; UI is a client)

`handover.create`, `handover.list`, `handover.get`, `handover.add_entry`,
`handover.update_entry`, `handover.remove_entry`, `handover.assign_entry`,
`handover.draft_entry`. Roles admin/member/agent; reads need a company member; writes are the
owner's. Every page form maps to one of them in `ui-parity.ts`.

## 4. Deferred (next steps)

1. **Automatic upkeep.** Today the brain drafts when it is asked or when it decides to call
   `handover.draft_entry` in a turn. Next: on a new memory item / note / call recap of the
   owner, a Jev kind "does this belong to one of my handovers, and which topic?" (closed set
   = the owner's handovers × their topics + "new topic" + "none"); the topic name of a new
   topic is LLM text. Runs in the owner's session, so only their own items are read.
2. **Suggested assignee** (Jev over the members, owner confirms) — today assigning is manual.
3. **Unassign / reassign** while the task is open (needs a "withdraw" on assigned tasks).
4. Rename / delete a handover; hand a handover to another owner.
5. Entry history (what the entry said before) and a "changed since you last looked" mark.
6. Day in the owner's time zone (today: UTC day of the change).
