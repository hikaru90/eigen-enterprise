# Company OS — Architecture

**Version:** 0.1 (draft)
**Status:** Working document
**Runtime:** Node.js / TypeScript
**Substrate:** Single VPS, Docker Compose
**Primary interface:** Agent
**Fallback interface:** SvelteKit shell
**Module distribution:** Git
**Email:** Owlery (self-hosted, SES-backed)

> Owner's vision doc, captured 2026-09-21. Executed against by `plan/phase-wedge.md` — the wedge thin slice implements Phases 1 (+ parts of 2/3) of the roadmap below, nothing more.

---

## 1. Concept

A company operating system. Everything a company needs — brand, identity, design, tone of voice, website, shop, operations — is expressed as modules running on a single web server. The user does not click through admin panels. They talk to an agent, and the agent activates, configures, and orchestrates modules on demand.

The OS metaphor:

| OS concept | This system |
|---|---|
| Kernel | Agent harness |
| Shell | SvelteKit shell (fallback UI host) |
| Processes | Modules |
| Package manager | Git + module registry |
| System calls | Agent tools |
| Filesystem | PostgreSQL + module dirs |
| IPC | BullMQ (Redis) |
| Device drivers | Shared services (email, storage, auth) |

---

## 2. Design Principles

1. **Agent is primary.** The operator interacts through conversation. Everything else is a fallback.
2. **UI is per-module, not global.** A module ships its own UI when conversation is a bad fit (design editors, shops, tables). The shell hosts it; it does not replace it.
3. **Everything is modular.** No monolith. Every capability is a module with a manifest, a lifecycle, and a boundary.
4. **Modules are git repos.** Distribution, versioning, updates, and rollbacks are git operations.
5. **One VPS, one stack.** Containerized, self-hosted, no external platform dependencies.
6. **Privilege separation.** The operator agent holds full context. User-facing agents are sandboxed, scoped, and separate — never the same agent.
7. **Async by default.** Anything slow or risky goes through the queue.
8. **One language.** Node/TypeScript across agent, workers, shell, and modules.

---

## 3. High-Level Architecture

```
                      ┌────────────────────────┐
                      │   OPERATOR (chat)      │
                      └───────────┬────────────┘
                                  │ WebSocket / HTTP
                      ┌───────────▼────────────┐
                      │   AGENT HARNESS        │
                      │   (Node / TypeScript)  │
                      │   - LLM reasoning loop │
                      │   - tool registry      │
                      │   - module orchestrator│
                      │   - session + memory   │
                      └───────────┬────────────┘
                                  │
        ┌─────────────────────────┼──────────────────────────┐
        │                         │                          │
        ▼                         ▼                          ▼
┌───────────────┐        ┌───────────────┐          ┌───────────────┐
│  BULLMQ       │        │  POSTGRESQL   │          │  SVELTEKIT    │
│  (Redis)      │        │ state,memory │          │  SHELL (UI)   │
└───────┬───────┘        └───────────────┘          └───────┬───────┘
        │                                                   │
        ▼                                                   ▼
┌───────────────┐        ┌───────────────┐          ┌───────────────┐
│  WORKER       │        │  OWLERY       │          │  MODULE UIs   │
│  (Node)       │───────▶│  (email)      │          │  (SvelteKit)  │
└───────┬───────┘        └───────────────┘          └───────────────┘
        │
        ▼
┌───────────────┐
│  GIT MODULES  │
│  /var/modules │
└───────────────┘
```

All containers on one VPS, behind Caddy.

---

## 4. Substrate

### 4.1 Host

- **OS:** Ubuntu 22.04 or 24.04 LTS
- **Deployment:** Single VPS (bare metal or VM)
- **Minimum specs:** 4 vCPU, 8–16 GB RAM, 40+ GB SSD

### 4.2 Containers

Docker + Docker Compose. Every service runs in its own container.

| Container | Role |
|---|---|
| caddy | Reverse proxy, automatic HTTPS |
| postgres | Primary database |
| redis | Cache, sessions, queue backend |
| agent | Agent harness + HTTP/WebSocket server |
| worker | BullMQ job processor |
| shell | SvelteKit shell |
| owlery | Email service |
| module-* | One container per active module (optional) |

### 4.3 Reverse Proxy

Caddy. Automatic TLS via Let's Encrypt. Routes:

- `chat.<domain>` → agent (WebSocket + HTTP)
- `app.<domain>` → SvelteKit shell
- `m/<module>.<domain>` or `app.<domain>/m/<module>` → module UIs
- `mail.<domain>` → Owlery (if exposed; internal-only is preferred)

---

## 5. Data Layer

### 5.1 PostgreSQL

System of record. Stores:

- Company configuration
- Module registry (installed, versions, status)
- Brand assets metadata, design tokens, tone-of-voice rules
- User accounts, permissions, audit logs
- Agent memory (sessions, long-term state)
- pgvector extension for embeddings (retrieval over company knowledge)

Schema isolation: each module gets its own Postgres schema (`module_<name>`). Modules never touch each other's tables directly.

### 5.2 Redis

Three roles:

1. **Cache:** frequently read config, rendered fragments, session tokens
2. **Queue backend:** BullMQ
3. **Pub/Sub:** real-time events between agent, workers, and modules

---

## 6. The Agent Harness

The agent is the kernel of the OS. It does not do work itself — it orchestrates.

### 6.1 Structure

```
agent/
├── core/
│   ├── loop.ts          ← reasoning loop (reason → tool → observe)
│   ├── llm.ts           ← provider abstraction
│   └── memory.ts        ← session + long-term memory
├── tools/
│   ├── install-module.ts
│   ├── configure-module.ts
│   ├── list-modules.ts
│   ├── send-email.ts
│   └── ...
├── registry/
│   └── modules.ts       ← installed modules, status, paths
└── server.ts            ← WebSocket / HTTP entry
```

### 6.2 Responsibilities

1. Understand operator intent from natural language
2. Decide which module(s) to invoke, configure, or install
3. Call the module's tool, CLI, or API
4. Track state across modules
5. Expose the control surface

### 6.3 Tools

Every capability is a tool. Built-in tools cover module management:

- `install_module(gitUrl)`
- `configure_module(name, config)`
- `activate_module(name)`
- `deactivate_module(name)`
- `remove_module(name)`
- `list_modules()`
- `send_email(...)`
- `open_ui(module, path)` — routes the shell to a module UI

Modules register additional tools when active. The agent's tool registry is the union of built-ins and loaded module tools.

### 6.4 Invocation channels

| Channel | When | How |
|---|---|---|
| Tool call (in-process) | Fast, safe actions | Direct function call |
| Queued job | Slow or risky actions | BullMQ job → worker → event back |

Rule of thumb: **synchronous = fast + safe; queued = slow or risky.**

### 6.5 Agent classes

| Class | Audience | Privilege |
|---|---|---|
| Operator agent | Owner / operator | Full company context. Root. |
| User-facing agent | End customers / staff | Sandboxed, scoped per module. Never the same as the operator agent. |

**Hard rule:** one operator agent per company. Zero or more user-facing agents, each scoped to a module, each configured by the operator agent. They never merge.

---

## 7. Module System

### 7.1 A module is a git repository

```
my-module/
├── module.json          ← manifest (the contract)
├── package.json         ← Node deps
├── src/
│   ├── index.ts         ← entry (exports actions)
│   └── tools.ts         ← tools exposed to the agent
├── ui/                  ← optional SvelteKit micro-frontend
│   └── ...
├── migrations/          ← optional DB migrations
└── README.md
```

### 7.2 Module manifest (`module.json`)

The manifest is the contract between the module, the agent, the queue, the shell, and the database. Every module declares:

- **Identity:** name, version, description, author
- **Source:** git URL, ref (branch/tag/commit)
- **Capabilities:** what it does
- **Tools:** actions the agent can call (name, schema, handler)
- **UI:** whether it exposes a UI, and at what route
- **Migrations:** DB schema, migration files
- **Dependencies:** other modules, shared services, env vars
- **Permissions:** DB schemas, filesystem paths, network access
- **Lifecycle hooks:** install, configure, activate, deactivate, remove

(Full schema to be drafted as a separate document.)

### 7.3 Lifecycle

```
available → installing → installed → configuring → configured → active → updating → removed
```

Each transition is driven by the agent and executed by a worker.

### 7.4 Install flow

1. Agent enqueues `module.install` with the git URL
2. Worker clones the repo into `/var/modules/<name>`
3. Worker reads `module.json`
4. Worker runs `npm install && npm run build`
5. Worker runs migrations against the module's Postgres schema
6. Worker registers the module in the registry table
7. Worker starts the module (child process, or its own container)
8. Worker emits `module.installed` event
9. Agent informs the operator

### 7.5 Update and rollback

- **Update:** `git pull` → rebuild → migrate → restart
- **Rollback:** `git checkout <tag>` → rebuild → restart
- **Versioning:** git tags are versions

### 7.6 Distribution

- **Official modules:** your repos (or a monorepo with subdirectories)
- **Third-party modules:** any git URL the operator trusts. The agent asks for confirmation before cloning from an unknown source.
- **Local modules:** a directory on disk, for development.

The registry is a small DB table listing known modules and their git URLs. No package registry service required.

---

## 8. Queue (BullMQ)

Redis-backed. One queue, multiple job types.

### 8.1 Job types

| Job | Purpose |
|---|---|
| `module.install` | Clone, build, migrate, register, start |
| `module.update` | Pull, rebuild, migrate, restart |
| `module.remove` | Stop, unregister, optionally drop schema |
| `module.configure` | Apply configuration changes |
| `email.send` | Hand off to Owlery |
| `agent.task` | Long-running agent operations |
| `cron.*` | Scheduled jobs |

### 8.2 Workers

Separate Node processes (`worker.ts`). One worker process with concurrency is sufficient on a single VPS. Multiple workers for horizontal scaling later.

### 8.3 Events

Workers emit events on completion. The agent subscribes and reports back to the operator without polling.

---

## 9. Shared Services

Shared services are **not** modules. They are infrastructure every module can use.

### 9.1 Email — Owlery

Owlery is a self-hosted, SES-backed email service. It slots in as the email provider for the whole OS.

Flow:

1. Agent or module enqueues `email.send`
2. Worker picks up the job
3. Worker calls Owlery's API
4. Owlery handles SES handoff, templates, tracking, retries

Placement: own container, internal Docker network. Exposed externally only if needed.

Why: email is a shared service, not a module. Keeping it out of the module graph keeps dependencies clean.

### 9.2 Other shared services (future)

- **Storage:** object storage for assets (images, files). S3-compatible, self-hosted (MinIO) or external.
- **Auth:** shared session + identity layer for the shell and module UIs.
- **Logging / observability:** structured logs, metrics, traces.

---

## 10. Shell (SvelteKit)

The shell is the fallback UI host. It is **not** the primary interface. Keep it thin.

### 10.1 Responsibilities

1. Host module UIs when conversation is a bad fit
2. Provide consistent chrome (auth, nav, notifications)
3. Route the agent's `open_ui` commands to the right place

### 10.2 Routing

```
src/routes/
├── +layout.svelte        ← chrome, auth, nav
├── m/[module]/[...path]/ ← module UI mount point
└── ...
```

### 10.3 Integration patterns

| Pattern | Description | When |
|---|---|---|
| Route mounting | Shell proxies to a module's internal UI server | v1 — simplest |
| Micro-frontend | Modules export Svelte components; shell dynamically imports them | Later — better UX, more build work |

Start with route mounting. Migrate to micro-frontends without changing the module contract.

---

## 11. Security and Privilege

### 11.1 Agent classes

- **Operator agent:** full context. Only the owner talks to it.
- **User-facing agents:** sandboxed, scoped per module, configured by the operator agent. Never the same agent.

### 11.2 Module boundaries

- Each module gets its own Postgres schema
- Each module declares required permissions in its manifest
- The agent enforces permissions at tool-call time
- Modules run in isolated processes or containers

### 11.3 Trust

- First-party modules: trusted by default
- Third-party modules: operator confirmation required before install
- Secrets: stored in a vault (to be designed), injected as env vars at container start

---

## 12. Technology Summary

| Layer | Technology |
|---|---|
| Host OS | Ubuntu 22.04 / 24.04 LTS |
| Containers | Docker + Docker Compose |
| Reverse proxy | Caddy |
| Runtime | Node.js / TypeScript |
| Agent | Node + LLM loop |
| Shell | SvelteKit |
| Modules | Git repos, Node packages |
| Database | PostgreSQL (+ pgvector) |
| Cache / Queue | Redis + BullMQ |
| Email | Owlery (SES-backed) |
| Storage | MinIO or S3-compatible (future) |

---

## 13. Open Questions

1. **Module manifest schema** — the exact shape of `module.json`. This is the next artifact to draft.
2. **Agent-to-module protocol** — tool calls vs. HTTP APIs vs. CLI. Which surface does a module expose by default?
3. **Vault / secrets** — where do secrets live, how are they injected, how are they rotated?
4. **User-facing agent boundary** — what data can a user-facing agent see? Allowlist per agent, or per module?
5. **Escalation channel** — can a user-facing agent escalate to the operator agent? Isolated or hierarchical?
6. **Staff agent tier** — a middle class between operator and customer? Many companies will need it.
7. **Shell ↔ agent routing** — how does the agent say "open the shop editor" and have the shell respond?
8. **Module UI build pipeline** — how are module SvelteKit apps built and served? One build per module, or shared?
9. **Backups** — Postgres, module dirs, Owlery data. Schedule, destination, restore procedure.
10. **Observability** — logs, metrics, traces. What's the minimum viable setup?

---

## 14. Roadmap Sketch

**Phase 1 — Core loop**

- Agent harness with a minimal tool registry
- One module (e.g. website generation) installed from git
- Postgres + Redis + BullMQ
- Operator talks to agent, agent installs and activates the module

**Phase 2 — Shell + UI fallback**

- SvelteKit shell with route mounting
- Module UI served through the shell
- Auth across shell and modules

**Phase 3 — Shared services**

- Owlery integration
- Storage service
- Secrets / vault

**Phase 4 — Module ecosystem**

- Manifest schema finalized
- Third-party module install flow
- Update / rollback flow

**Phase 5 — Agent classes**

- User-facing agent sandbox
- Per-module scoping
- Escalation channel (if needed)

---

## 15. Glossary

| Term | Meaning |
|---|---|
| Agent | The LLM-driven harness that orchestrates modules |
| Operator agent | The privileged agent the owner talks to |
| User-facing agent | A sandboxed agent scoped to a module |
| Module | A git repo with a manifest, tools, and optional UI |
| Manifest | `module.json` — the module's contract |
| Shell | The SvelteKit fallback UI host |
| Shared service | Infrastructure every module can use (email, storage, auth) |
| Queue | BullMQ on Redis — async job processing |
| Worker | The Node process that consumes queue jobs |

---

*End of draft. Next artifact: `module.json` schema.*
