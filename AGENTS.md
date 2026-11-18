# eigenEnterprise — Agent Working Agreement

**The website is the company.** eigenEnterprise is an AI-native company OS: SvelteKit + Postgres (pgvector + Apache AGE), single-tenant per company, Apache-2.0. Customer zero: Kindred Digital Labs. See [`plan/phase-0-kernel.md`](plan/phase-0-kernel.md) for the approved architecture.

## Orchestrator model (how agents work here)

- The **main agent is the orchestrator**. It owns the plan in `plan/`, decomposes work, and **delegates to subagents** (Task tool) for research, exploration, and scoped implementation.
- **Parallel work happens in git worktrees**, one workstream per branch (`git worktree add ../ee-<stream> -b <stream>`). Workstreams touch disjoint file sets by design. The orchestrator reviews, merges into `main`, and prunes the worktree.
- The orchestrator never does what a subagent could do in parallel; it integrates, decides, and keeps `main` green.
- **Every agent edits only within its workstream scope.** Cross-cutting changes go back to the orchestrator.

## Progress documentation (non-negotiable)

- `plan/` is the source of truth: approved phase plans (`plan/phase-*.md`) and **`plan/progress.md`**.
- After every completed milestone (and before ending a session), update `plan/progress.md`: what shipped, commit refs, what broke, decisions taken, what's next.
- Decisions with architecture impact get a line in `plan/progress.md` (decision log section) — no silent choices.

## One install: the ee box (owner decision, 2026-10-23)

- There is **no dev server**. The ee box (`ee/e2e/box.sh`, https://os.ee.localhost) is the only running eigenEnterprise on this machine — the same systemd + Caddy + ee shape as production. Do not add a `dev` script or run `vite dev`.
- Develop against tests: unit (`npm run test:unit`) and component (`npm run test:components`, real Svelte in a real browser). Browser e2e (`npm run test:e2e`) starts its own throwaway harness — Vite in dev mode on :4173 (the sign-in-code harness routes exist only there) + the mock gateway on :5199 — and Playwright stops both when the run ends. It never reuses a running server; nothing stays running.
- See a change live: commit, `scripts/release.sh arm64`, `ee/e2e/box.sh install os.ee.localhost`. Shipped means committed, pushed and on the box.
- The compose Postgres (`npm run db:up`, :5433) is the test database only.

## Engineering guardrails (carried from eigen — still binding)

- **Drizzle migrations:** every schema change needs BOTH `drizzle/NNNN_name.sql` AND a journal entry in `drizzle/meta/_journal.json` (idx sequential, tag = filename without `.sql`), plus schema update in `src/lib/server/db/`. `scripts/migrate.mjs` fails fast on mismatch.
- **TDD:** tests first for features/fixes (vitest unit; Playwright headed for e2e). No weakening assertions to green a build — fix root causes, never work around them.
- **No fallbacks / no silent degradation:** no `|| 'localhost'` default envs, no bypass paths, no temporary shims. Fail loud with explicit errors.
- **No silent removals:** removing or replacing working functionality (a workflow, an option, a page, a tool) is announced to the owner BEFORE it ships — in the session summary and `plan/progress.md`. Regressions of working flows are treated as bugs, not refactor side effects.
- **No string heuristics for meaning:** never regex/keyword/substring logic to decide semantic anything (classification, routing, entity typing). Always LLM + ontology + JSON schema. Post-LLM code may only parse/validate/persist.
- **Svelte:** no `$effect` for control flow — explicit events, handlers, `onMount`. `$derived` for pure view state is fine.
- **LLM middleware:** all model calls go through the gateway (`src/lib/server/llm/`) — never direct provider calls. Cost tracking stays attached.
- **Secrets:** never commit; never log raw credentials (redact `*key`, `*token`, `*secret`, `password`).

## Commands

| Task | Command |
|---|---|
| Unit tests | `npm test` |
| Coverage | `npm run test:coverage` |
| Typecheck | `npm run check` |
| Lint | `npm run lint` |
| Test DB | `npm run db:up` |
| E2E (throwaway harness) | `npm run test:e2e` |
| Release to the box | `scripts/release.sh arm64 && ee/e2e/box.sh install os.ee.localhost` |
| Migrations (test DB) | `npm run db:migrate` |

## Repo map

- `plan/` — plans + progress (this governs everything)
- `src/lib/kernel/` — action registry, principals, events, modules, vcs, approvals, admin tools
- `src/cli/` — `ee` CLI: thin dispatcher over kernel registry tools (agents' native hands, no MCP hop)
- `src/lib/server/` — existing eigen services being promoted into modules (memory, owlery client, llm, job-queue, mcp)
- `modules/` — module manifests + implementations (baseline: website, orchestrator/agent, chat-gateway, memory, email)
- `drizzle/` — SQL migrations + journal (see guardrails)
- `ee/` — the company's init (plan/phase-substrate.md): one bundled binary under systemd that installs and runs eigenEnterprise and apps on a server; `ee/e2e/` holds the local systemd test box + browser journey

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- For any AWS task or question — building, configuring, migrating, debugging, or operating a service, writing SDK code, authoring CDK/CloudFormation, or answering how a service works — first call `aws___search_documentation` with topic `agent_skills` and load the matching skill with `aws___retrieve_skill`. Do this even when you believe you know the answer: skills carry current service behavior that your training may not. Prefer the skill's guidance over general knowledge. Skip it only for work that does not involve AWS.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion
<!-- END AWS Agent Toolkit rules -->
