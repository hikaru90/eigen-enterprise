-- company-os 0001: sessions, messages, company memory (append-only).
-- The slice's own migration path: files in this directory run once, in filename
-- order, tracked in schema_migrations (see src/migrate.ts). Never edit an
-- applied file — add a new one.

create table if not exists agent_sessions (
    id uuid primary key default gen_random_uuid(),
    status text not null default 'open' check (status in ('open', 'completed')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists agent_messages (
    id bigint generated always as identity primary key,
    session_id uuid not null references agent_sessions(id) on delete cascade,
    seq integer not null,
    role text not null check (role in ('system', 'user', 'assistant', 'tool')),
    content text,
    tool_calls jsonb,
    tool_call_id text,
    created_at timestamptz not null default now(),
    unique (session_id, seq)
);

-- Append-only: answers are never overwritten ("nothing is lost, ever").
-- Readers use latest-per-(kind,key).
create table if not exists company_memory (
    id uuid primary key default gen_random_uuid(),
    kind text not null,
    key text not null,
    value text not null,
    source text not null default 'conversation',
    created_at timestamptz not null default now()
);

create index if not exists company_memory_kind_key_idx on company_memory (kind, key, created_at desc);
