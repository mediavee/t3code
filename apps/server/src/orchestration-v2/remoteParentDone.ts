/**
 * A remote task whose thread there has not yet been told its parent here is done. The partial
 * index on it is only used when the read spells this text the same way, on an unaliased table.
 */
export const REMOTE_TASK_OWED_PARENT_DONE_CONDITION = `origin = 'app_owned' AND child_thread_id IS NULL
  AND json_valid(payload_json)
  AND json_type(payload_json, '$.remoteChild') = 'object'
  AND json_type(payload_json, '$.remoteChild.parentDoneThere') IS NOT 'true'`;

/** A remote task whose follower must still stop it there or read its result, on the unaliased table. */
export const OPEN_REMOTE_TASK_CONDITION = `origin = 'app_owned'
  AND child_thread_id IS NULL
  AND json_type(payload_json, '$.remoteChild') = 'object'
  AND (
    json_type(payload_json, '$.result') = 'null'
    OR (
      json_extract(payload_json, '$.status') IN ('cancelled', 'interrupted')
      AND json_type(payload_json, '$.remoteChild.stoppedThere') IS NOT 'true'
    )
    OR json_type(payload_json, '$.remoteChild.stoppedThere') = 'false'
  )`;
