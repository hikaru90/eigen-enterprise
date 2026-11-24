-- ee:no-transaction
-- Module event delivery (plan/phase-upgrades-u2.md §4.4) reads kernel_events by type in (ts, id) order.
-- CONCURRENTLY: kernel_events can be large on a running box, and a plain CREATE INDEX would block its writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "kernel_events_type_ts_id_idx" ON "kernel_events" ("type", "ts", "id");
