# Access contract (`$lib/server/access`)

One model for "who may see/change this" (plan/phase-workspace.md §2). Built in
T1; Drive (`folder`, `file`) and Messages (`channel`) consume it.

```ts
import { canAccess, listGrants, setGrants, registerResourceResolver } from '$lib/server/access'

type ResourceType = 'channel' | 'folder' | 'file'
type AccessLevel  = 'view' | 'edit' | 'manage'            // view < edit < manage
type Subject      = { kind: 'user'; userId: string } | { kind: 'group'; groupId: string } | { kind: 'company' }
type Grant        = { resourceType: ResourceType; resourceId: string; subject: Subject; level: AccessLevel }
type ResourceChain = { ancestors?: readonly string[] }   // containing folder ids, NEAREST PARENT FIRST

canAccess(userId, resourceType, resourceId, level, chain?: ResourceChain): Promise<boolean>
listGrants(actorId, resourceType, resourceId, chain?): Promise<Grant[]>          // actor needs 'view'
setGrants(actorId, resourceType, resourceId, grants: {subject, level}[], chain?): Promise<Grant[]>  // actor needs 'manage'; replaces the set
registerResourceResolver(resourceType, (resourceId) => Promise<boolean>): void
```

Rules:

- **Owner and admins always have `manage`** (on any resource that exists).
- Everyone else: the **strongest** grant that applies — to the user, to any
  group they belong to, or to `company` (every member) — on the resource
  itself or on any folder in `chain.ancestors`.
- **Folder inheritance via the chain:** this module never walks folders. The
  caller (Drive) passes the containing folders' ids, nearest parent first, up
  to the root. A grant on any of them applies. `chain` is only valid for
  `folder`/`file`; passing ancestors for a `channel` throws `invalid_chain`.
  The resource itself must be in the resolver; ancestors are trusted as given.
- **Fail closed:** empty ids, unknown users (no `user` row — e.g. removed
  members), unknown levels and resources whose resolver says "no such id" →
  `false`. A resource type with **no registered resolver throws** (fail loud:
  the owning module must call `registerResourceResolver` at load).
- `setGrants` validates every subject (existing user/group, no duplicates) and
  writes one kernel event `access.grants_set` (`principalId` = actor, payload
  `{resourceType, resourceId, before, after}`).
- Removing a member or deleting a group drops their grants (FK cascade,
  migration 0107).
- Tests inject `createAccess({ store: memoryAccessStore(...), audit, resolvers })`.
