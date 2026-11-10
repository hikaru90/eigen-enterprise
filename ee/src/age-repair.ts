/**
 * Apache AGE keeps each graph's id as plain data (ag_graph.graphid, and
 * ag_label.graph for every label) — the oid of the graph's schema. A
 * pg_dump / pg_restore recreates that schema under a new oid, so a restored
 * database has a graph AGE cannot find ("graph with oid … does not exist")
 * until these ids are pointed at the new schema. Idempotent: a no-op when they
 * already match. Runs as the superuser (it alters ag_catalog).
 *
 * Proven on a restored copy of a live company database (2026-11-10): before,
 * the eigen_app graph write probe failed; after, it passes.
 */
export const AGE_REPAIR_SQL = [
  'BEGIN;',
  'ALTER TABLE ag_catalog.ag_label DROP CONSTRAINT IF EXISTS fk_graph_oid;',
  'UPDATE ag_catalog.ag_label l SET graph = g.namespace::oid FROM ag_catalog.ag_graph g WHERE l.graph = g.graphid AND g.graphid <> g.namespace::oid;',
  'UPDATE ag_catalog.ag_graph SET graphid = namespace::oid WHERE graphid <> namespace::oid;',
  'ALTER TABLE ag_catalog.ag_label ADD CONSTRAINT fk_graph_oid FOREIGN KEY (graph) REFERENCES ag_catalog.ag_graph(graphid);',
  'COMMIT;',
].join('\n')
