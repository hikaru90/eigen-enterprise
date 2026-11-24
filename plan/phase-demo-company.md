# Phase: Demo company — a live eigenEnterprise to link from the website

**Status:** APPROVED (owner, 2026-11-23): "we need a mockup demo company with dummy data for linking on the website". Access model revised by owner (2026-11-24): **one-click login-free entry into one shared Northwind Studio teammate**, with **1–2 AI calls per visitor IP per UTC day**.

## 1. What it is

- A **hosted company on our cloud** (owner, 2026-11-23: "Hosted in the cloud"): slug `demo` → **demo.eigenenterprise.app**, on rs500-1 like any customer. Platform AI, backups and releases come from the fleet. It runs no special demo build. (Adopting the local box was rejected: visitors can't reach `os.ee.localhost`, and fleet releases would fight local installs.)
- It holds one made-up company, **Northwind Studio**: a 6-person design and web agency in Hamburg. It has contacts and a sales pipeline, projects with tasks, message channels with history, calendar events, Drive documents, a brand (style + voice) and website pages, plus brain memories that make "ask the company brain" answer well.
- Visitors click **Demo** on eigenenterprise.app (or open `demo.eigenenterprise.app` / `/signup`) and land on a one-click welcome card (**Explore Northwind Studio**). Clicking it signs them in as the configured shared Northwind `member` teammate (default: Sophie Wagner, `sophie.wagner@northwind-studio.example`) — no email, no code, no extra user rows, no profile gate. Team/owner sign-in remains available under **Team sign in** on `/login`.
- AI spend is protected by a per-IP daily AI turn limit (default: 2 turns per IP per UTC day, storing only SHA-256 IP hashes; background jobs for the shared guest account are refused) plus the company's outer `llm.member_daily_cap_usd`.
- The data resets every night.

## 2. Decisions (2026-11-23)

- **D1 — Open join is a company setting, not a demo hack.** `members.open_join` (off by default; owner/admin can switch it): when on, `/signup` on a claimed box lets anyone with a verified email join as `member`. It is a registry tool plus a Settings › Members toggle, and is useful beyond the demo (open communities, internal pilots).
- **D2 — Per-person daily AI cap.** A company setting `llm.member_daily_cap_usd` (unset = no cap), enforced in the gateway for members (owner/admin exempt). Over the cap, the person gets a plain refusal. The demo sets it low.
- **D3 — The seed goes through the registry.** The seed is the registry tool `demo.seed_company` (module `demo`, off by default; revised 2026-11-23 so it runs on an installed box): it drives registry tools in-process as the owner and each teammate, the same path the `ee` CLI and the agent take. The dataset is plain data in `modules/demo/data/`; `npm run demo-company -- seed` is a thin checkout entry over the tool. Teammates become real members through the members code paths. Direct DB writes happen only where no path exists, and each such gap is logged as parity debt.
- **D4 — Reset = restore the empty snapshot, then seed again (revised 2026-11-23).** Right after the claim, take an ee snapshot of the empty company and pin its id. A nightly timer on the demo box runs `ee restore --snapshot <pinned>`, then calls `demo.seed_company` (MCP, the owner's API key), so dates stay current. Restoring a seeded snapshot would freeze "this week" on the snapshot day. No new destructive "wipe" path.
- **D5 — Website.** The header **Demo** button goes to the live demo. "Book a demo" (mailto) stays as the call-to-action at the end of content pages (announced change: the header button no longer opens a mail).
- **D6 — Login-free shared demo seat (owner, 2026-11-24).** Strictly double-gated inside the internal `demo` module (`demo.guest_access_get` / `demo.guest_access_set`, owner-only, approval risk `public`, off by default on every company, migration 0178 `demo_guest_access` + `demo_guest_ai_usage`). Only takes effect when `demo` module is active AND `enabled = true` AND the target user is a human `member` (never owner/admin/co-worker). `/login` shows a one-click welcome card; `/signup` redirects to `/login` when active; `profileGateRedirect` exempts the active guest teammate so visitors enter immediately. Gateway enforces `ai_calls_per_ip` (default 2) per SHA-256 IP hash per UTC day, counting multi-step tool turns as 1 turn (hard cap 12 raw gateway calls per turn) and refusing background AI jobs for the guest account.

## 3. Milestones

- **DC1 — Seed (M):** dataset + `demo-company seed`, proven on the test DB and the local box.
- **DC2 — Open join (S–M):** setting, tool, `/signup` path, Settings toggle, parity entry, tests.
- **DC3 — Member AI cap (S–M):** setting, tool, gateway enforcement, tests.
- **DC4 — Hosted demo company:** release with the demo module → owner: cloud /ops → New company, slug `demo` (card via the Stripe link, owner rule 2026-11-17) → claim → `kernel.module_activate demo` → `demo.seed_company`, `members.set_open_join on`, `settings.member_ai_cap_set`. Nightly reset on a hosted box is still open: `ee restore` needs the recovery code (the control plane holds an escrowed backup key), and the reseed needs an owner API key plus an approval each night.
- **DC5 — Website link:** after DC4 is live.
