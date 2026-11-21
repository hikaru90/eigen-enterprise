# ee — eigenEnterprise CLI

Agents' native hands: an in-process kernel surface, no MCP hop. `ee` is a
**thin dispatcher over the kernel registry** — it has no special powers. Every
command, including admin operations, goes through
`KernelRegistry.execute` (permission → approval → validation → handler →
audit → vcs), exactly like the MCP server and the web UI.

## Setup

- Requires `DATABASE_URL` (the kernel boots DB-backed: activation, approval,
  audit, and principal stores live in the `kernel_*` tables).
- Auth: pass `--principal <id>` (wins) or set `EE_CLI_PRINCIPAL_ID`. There is
  no fallback — a missing or unknown principal exits 1 loudly. Roles come from
  `kernel_principals`; module ops need `admin`, approval ops need `owner`.

## Commands

```
ee status                                        # modules + pending approvals (admin+owner)
ee tool list [--module <id>] [--namespace <ns>] [--json]
                                                 # active-module tools only (same fail-closed
                                                 #   activation filter as MCP tools/list)
ee tool namespaces                               # tool-name prefixes with tool counts
ee tool help <name>                              # one tool: description, input schema, approval, active
ee tool run <name> --input '<json>'              # execute any registered tool
ee module list | activate <id> | deactivate <id> # via kernel.module_* tools (admin)
ee approvals list [--status pending|approved|denied]
ee approvals decide <id> --approve|--deny        # via kernel.approvals_decide (owner)
ee openapi                                       # OpenAPI 3.1 document over the registry
```

Global flags: `--json`, `--principal <id>`, plus `--input`, `--module`,
`--namespace`, `--status`, `--approve`, `--deny` per command (`--flag value` or `--flag=value`).

Exit codes: `0` ok · `1` error (structured `{ code, message }` on stderr) ·
`3` approval_required (includes the pending `approvalId` when one exists).

## The company brain's `ee` tool

The "Ask the company brain" agent has the CLI as one tool, `ee`
(`brain-tool.ts`, wired in `src/lib/server/boot.ts` as an agent meta tool next
to its direct registry tools). The model passes the CLI words and, for
`tool run`, the tool input as a JSON object:

```json
{ "args": ["tool", "namespaces"] }
{ "args": ["tool", "list", "--namespace", "reminders"] }
{ "args": ["tool", "help", "reminders.create"] }
{ "args": ["tool", "run", "reminders.list"], "input": {} }
```

It runs in process through `executeCommand` (the same handlers as the
terminal) as the **asking person** (the run's delegated principal): the
registry's activation gate, role check, approvals, audit and RLS scope are
the ones a direct call meets. Discovery shows only the tools the person may
run (their roles ∩ the agent's tool scope), lists without schemas (`tool help`
carries one), so the model's context stays small. `--principal` and `openapi`
are refused; the agent's tool scope holds on `tool run` too.

## Kernel admin tools

The admin surface itself is kernel tools (`src/lib/kernel/admin-tools.ts`,
composed in `src/lib/kernel/admin-bootstrap.ts`): `kernel.module_list`,
`kernel.module_activate`, `kernel.module_deactivate`, `kernel.approvals_list`,
`kernel.approvals_decide` — all registered under module id `kernel`. The CLI
merely calls them; agents and the web UI can call the same tools through any
kernel surface.

## Examples

```sh
# capture a thought as an agent principal
ee tool run memory.capture_thought --input '{"thought":"..."}' --principal <uuid>

# see what is awaiting a decision, then approve it
ee approvals list --status pending --principal <owner-uuid>
ee approvals decide <approval-id> --approve --principal <owner-uuid>

# activate a module (makes its tools executable everywhere)
ee module activate memory --principal <uuid>

# machine-readable everything
ee tool list --module memory --json --principal <uuid>
```

Run via `npm run ee -- <args>` or `npx tsx src/cli/index.ts <args>`.
