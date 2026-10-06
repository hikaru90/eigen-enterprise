-- company-os 0002: provider config — the guided-setup store. The founder pastes
-- their LLM key ONCE in the UI; it lives in THEIR database on THEIR server,
-- never in env files. Single row (single tenant, decision W7 lineage).

create table if not exists provider_config (
    id integer primary key default 1 check (id = 1),
    base_url text not null,
    api_key text not null,
    model text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
