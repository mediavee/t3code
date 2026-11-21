import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { REMOTE_TASK_OWED_PARENT_DONE_CONDITION } from "../../orchestration-v2/remoteParentDone.ts";

// This fork's indexes stay out of effect_sql_migrations: the migrator skips every id up to the
// highest recorded, so a fork-numbered row would hide upstream's migration with that id.
const forkIndexes = [
  {
    name: "orchestration_v2_projection_subagents_remote_parent_done_idx",
    // Startup and each settled, archived or deleted thread look for remote tasks not yet told
    // their parent is done; this index holds only those rows. ProjectionStore's read must spell
    // the same predicate.
    statement: `
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_subagents_remote_parent_done_idx
    ON orchestration_v2_projection_subagents(thread_id, subagent_id)
    WHERE ${REMOTE_TASK_OWED_PARENT_DONE_CONDITION}
  `,
  },
  {
    name: "orchestration_v2_projection_turn_items_transient_failure_idx",
    // Transient-failure recovery and Resume all read recent retryable failures every few
    // seconds; failures are rare, so this index stays tiny. Keep this predicate identical to
    // ProjectionStore's getTransientFailureCandidates filter.
    statement: `
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_transient_failure_idx
    ON orchestration_v2_projection_turn_items(updated_at, thread_id)
    WHERE type = 'error' AND status = 'failed'
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.failure.retryable') = 1
        AND json_extract(payload_json, '$.failure.class') IS NOT 'usage_limit'
        ELSE 0 END
  `,
  },
] as const;

// Fork columns, added the same way for the same reason as the indexes above.
const forkColumns = [
  {
    // The thread of a scheduled task's last dispatch, so a due run waits while that thread is busy.
    table: "scheduled_tasks",
    column: "last_run_thread_id",
    statement: "ALTER TABLE scheduled_tasks ADD COLUMN last_run_thread_id TEXT",
  },
] as const;

const FORK_COLUMN_CONDITION = forkColumns
  .map(({ table, column }) => `(t.name = '${table}' AND c.name = '${column}')`)
  .join(" OR ");

const missingForkColumns = Effect.fn("missingForkColumns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const present = yield* sql<{ readonly tableName: string; readonly columnName: string }>`
    SELECT t.name AS tableName, c.name AS columnName
    FROM sqlite_master t, pragma_table_info(t.name) c
    WHERE t.type = 'table' AND (${sql.literal(FORK_COLUMN_CONDITION)})
  `;
  return forkColumns.filter(
    ({ table, column }) =>
      !present.some((row) => row.tableName === table && row.columnName === column),
  );
});

// Earlier fork builds recorded these indexes as numbered migrations; startup removes those rows.
const FORK_LEDGER_ROWS = [
  [103, "RemoteParentDoneIndex"],
  [104, "TransientFailureIndex"],
] as const;

const FORK_LEDGER_ROW_CONDITION = FORK_LEDGER_ROWS.map(
  ([id, name]) => `(migration_id = ${id} AND name = '${name}')`,
).join(" OR ");

const FORK_INDEX_NAMES = forkIndexes.map(({ name }) => `'${name}'`).join(", ");

/** The recorded history as startup leaves it once it has removed the fork's old ledger rows. */
export function withoutForkLedgerRows<Row extends { readonly id: number; readonly name: string }>(
  recorded: ReadonlyArray<Row>,
): ReadonlyArray<Row> {
  return recorded.filter(
    (row) => !FORK_LEDGER_ROWS.some(([id, name]) => row.id === id && row.name === name),
  );
}

/** Whether the fork's ledger rows, indexes or columns need work; expects the migration ledger to exist. */
export const forkIndexesPending = Effect.fn("forkIndexesPending")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly ledgerRows: number; readonly indexes: number }>`
    SELECT
      (SELECT COUNT(*) FROM effect_sql_migrations
        WHERE ${sql.literal(FORK_LEDGER_ROW_CONDITION)}) AS ledgerRows,
      (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'index' AND name IN (${sql.literal(FORK_INDEX_NAMES)})) AS indexes
  `;
  return (
    (row?.ledgerRows ?? 0) > 0 ||
    (row?.indexes ?? 0) < forkIndexes.length ||
    (yield* missingForkColumns()).length > 0
  );
});

/** Deletes the fork's old ledger rows, matched by id and name; returns what it removed. */
export const forgetForkLedgerRows = Effect.fn("forgetForkLedgerRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return [];
  const forgotten = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    DELETE FROM effect_sql_migrations WHERE ${sql.literal(FORK_LEDGER_ROW_CONDITION)}
    RETURNING migration_id, name
  `;
  return forgotten.map((row) => `${row.migration_id}_${row.name} (ledger row removed)`);
});

/** Creates the missing fork indexes and columns; returns their names. */
export const applyForkIndexes = Effect.fn("applyForkIndexes")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${sql.literal(FORK_INDEX_NAMES)})
  `;
  const existingNames = new Set(existing.map(({ name }) => name));
  const created: Array<string> = [];
  for (const { name, statement } of forkIndexes) {
    if (existingNames.has(name)) continue;
    yield* sql.unsafe(statement);
    created.push(name);
  }
  // The client begins IMMEDIATE, so a second process starting at once waits instead of adding the column twice.
  const addedColumns = yield* sql.withTransaction(
    Effect.gen(function* () {
      const added: Array<string> = [];
      for (const { table, column, statement } of yield* missingForkColumns()) {
        yield* sql.unsafe(statement);
        added.push(`${table}.${column}`);
      }
      return added;
    }),
  );
  return [...created, ...addedColumns];
});
