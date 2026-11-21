import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Transient-failure recovery and Resume all read recent retryable failures every few
  // seconds; failures are rare, so this index stays tiny. Keep this predicate identical to
  // ProjectionStore's getTransientFailureCandidates filter.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_transient_failure_idx
    ON orchestration_v2_projection_turn_items(updated_at, thread_id)
    WHERE type = 'error' AND status = 'failed'
      AND CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.failure.retryable') = 1
        AND json_extract(payload_json, '$.failure.class') IS NOT 'usage_limit'
        ELSE 0 END
  `;
});
