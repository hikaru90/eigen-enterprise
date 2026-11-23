# Phase: Demo company — a live eigenEnterprise to link from the website

**Status:** APPROVED (owner, 2026-11-23): "we need a mockup demo company with dummy data for linking on the website". Access model picked by the owner: **email code, own seat**.

## 1. What it is

- A separate eigenEnterprise install, **demo.eigenenterprise.app**, with the same release, ee and systemd shape as every other box. It runs no special demo build.
- It holds one made-up company, **Northwind Studio**: a 6-person design and web agency in Hamburg. It has contacts and a sales pipeline, projects with tasks, message channels with history, calendar events, Drive documents, a brand (style + voice) and website pages, plus brain memories that make "ask the company brain" answer well.
- Visitors click **Demo** on eigenenterprise.app and land on `demo.eigenenterprise.app/signup`. They type their email and get the normal sign-in code, then join Northwind as a **member**. There is no bypass sign-in and no shared guest account.
- The data resets every night, and visitor accounts go with it.

## 2. Decisions (2026-11-23)

- **D1 — Open join is a company setting, not a demo hack.** `members.open_join` (off by default; owner/admin can switch it): when on, `/signup` on a claimed box lets anyone with a verified email join as `member`. It is a registry tool plus a Settings › Members toggle, and is useful beyond the demo (open communities, internal pilots).
- **D2 — Per-person daily AI cap.** A company setting `llm.member_daily_cap_usd` (unset = no cap), enforced in the gateway for members (owner/admin exempt). Over the cap, the person gets a plain refusal. The demo sets it low.
- **D3 — The seed goes through the registry.** The seed is the registry tool `demo.seed_company` (module `demo`, off by default; revised 2026-11-23 so it runs on an installed box): it drives registry tools in-process as the owner and each teammate, the same path the `ee` CLI and the agent take. The dataset is plain data in `modules/demo/data/`; `npm run demo-company -- seed` is a thin checkout entry over the tool. Teammates become real members through the members code paths. Direct DB writes happen only where no path exists, and each such gap is logged as parity debt.
- **D4 — Reset = restore the empty snapshot, then seed again (revised 2026-11-23).** Right after the claim, take an ee snapshot of the empty company and pin its id. A nightly timer on the demo box runs `ee restore --snapshot <pinned>`, then calls `demo.seed_company` (MCP, the owner's API key), so dates stay current. Restoring a seeded snapshot would freeze "this week" on the snapshot day. No new destructive "wipe" path.
- **D5 — Website.** The header **Demo** button goes to the live demo. "Book a demo" (mailto) stays as the call-to-action at the end of content pages (announced change: the header button no longer opens a mail).

## 3. Milestones

- **DC1 — Seed (M):** dataset + `demo-company seed`, proven on the test DB and the local box.
- **DC2 — Open join (S–M):** setting, tool, `/signup` path, Settings toggle, parity entry, tests.
- **DC3 — Member AI cap (S–M):** setting, tool, gateway enforcement, tests.
- **DC4 — Demo box (owner):** provision the server, DNS for `demo.eigenenterprise.app`, install, claim, seed, snapshot, nightly restore timer.
- **DC5 — Website link:** after DC4 is live.
