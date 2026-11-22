import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import { COMMAND_OUTPUT_LIMIT } from "./payloadRetention.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";

const database = SqlitePersistence.layerMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
const layerTest = Layer.mergeAll(
  stores,
  OrchestrationEventStore.layer.pipe(Layer.provide(database)),
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  ProjectionReplay.layer.pipe(Layer.provide(stores)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: "Turn item compaction",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreated(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  return {
    id: EventId.make("event:turn-item-compaction:thread"),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  } satisfies OrchestrationV2DomainEvent;
}

const itemSpecs = [
  { key: "command", type: "command_execution", ordinal: 10 },
  { key: "reasoning", type: "reasoning", ordinal: 20 },
  { key: "todo", type: "todo_list", ordinal: 30 },
  { key: "commanded", type: "command_execution", ordinal: 40 },
] as const;

function itemEvent(
  threadId: ThreadId,
  now: DateTime.Utc,
  spec: (typeof itemSpecs)[number],
  revision: number,
  eventId = `event:turn-item-compaction:${spec.key}:${revision}`,
): OrchestrationV2DomainEvent {
  const id = TurnItemId.make(`turn-item:compaction:${spec.key}`);
  const growing = `${spec.key}:${revision}:` + "x".repeat((revision + 1) * 192);
  const completed = revision === 69;
  const base = {
    id,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: spec.ordinal,
    status: completed ? ("completed" as const) : ("running" as const),
    title: spec.key,
    startedAt: now,
    completedAt: completed ? now : null,
    updatedAt: now,
  };
  let payload: OrchestrationV2TurnItem;
  switch (spec.type) {
    case "command_execution":
      payload = {
        ...base,
        type: "command_execution",
        input: `run ${spec.key}`,
        output: growing,
      };
      break;
    case "reasoning":
      payload = { ...base, type: "reasoning", text: growing, streaming: !completed };
      break;
    case "todo_list":
      payload = {
        ...base,
        type: "todo_list",
        planId: PlanId.make("plan:turn-item-compaction"),
        steps: [{ id: "step", text: growing, status: completed ? "completed" : "running" }],
        explanation: growing,
      };
      break;
  }
  return {
    id: EventId.make(eventId),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  };
}

function subagentEvents(
  threadId: ThreadId,
  now: DateTime.Utc,
  revision: number,
  eventSuffix = String(revision),
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const id = NodeId.make("subagent:turn-item-compaction");
  const prompt = revision === 0 ? "Review prompt A. ".repeat(40) : "Review prompt B. ".repeat(40);
  const progress = `Review progress ${revision}`;
  return [
    {
      id: EventId.make(`event:turn-item-compaction:subagent:${eventSuffix}`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:turn-item-compaction-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver: providerDriver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: {
          driver: providerDriver,
          nativeId: "compaction-review",
          strength: "strong",
        },
        prompt,
        progress,
        title: "Review",
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    },
    {
      id: EventId.make(`event:turn-item-compaction:subagent-item:${eventSuffix}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:compaction:subagent"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 50,
        status: "running",
        title: "Review",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: id,
        origin: "provider_native",
        driver: providerDriver,
        providerInstanceId,
        childThreadId: null,
        prompt,
        progress,
        result: null,
      },
    },
  ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
}

const insertRunningRunUpdate = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'event:prune:run-running', 'thread', ${threadId},
        (SELECT MAX(stream_version) + 1 FROM orchestration_events WHERE stream_id = ${threadId}),
        'run.updated', '2026-11-01T00:00:00.000Z', 'server', '{"status":"running"}', '{}', 2
      ) RETURNING sequence
    `,
  );

const remainingEventIds = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly event_id: string }>`
      SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence
    `,
  ).pipe(Effect.map((rows) => rows.map((row) => row.event_id)));

it.effect("prunes events the projections cover once the retained day has passed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    for (const revision of [0, 1, 2]) {
      yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], revision)] });
    }
    yield* sink.write({ events: subagentEvents(threadId, now, 0) });
    yield* insertRunningRunUpdate(threadId);
    yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[1], 0)] });

    // The first pass only marks the head; nothing is a day old yet.
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    const markedThrough = yield* eventStore.latestSequence();

    // Repeating prompt A borrows it from the anchors written before the mark.
    yield* sink.write({ events: subagentEvents(threadId, now, 0, "repeat") });
    yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], 3)] });
    const highWater = yield* eventStore.latestSequence();
    const projection = yield* projections.getThreadProjection(threadId);

    yield* TestClock.adjust("23 hours");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    yield* TestClock.adjust("1 hour");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 4);

    assert.deepEqual(yield* remainingEventIds(threadId), [
      "event:turn-item-compaction:thread",
      "event:turn-item-compaction:subagent:0",
      "event:turn-item-compaction:subagent-item:0",
      "event:prune:run-running",
      "event:turn-item-compaction:subagent:repeat",
      "event:turn-item-compaction:subagent-item:repeat",
      "event:turn-item-compaction:command:3",
    ]);
    assert.equal(yield* events.prunedThroughSequence, markedThrough);
    assert.equal(yield* eventStore.latestSequence(), highWater);
    assert.equal(yield* eventStore.latestSequence({ threadId }), highWater);
    assert.deepEqual(yield* projections.getThreadProjection(threadId), projection);
    const repeated = yield* eventStore
      .read({ threadId, eventType: "subagent.updated", afterSequence: markedThrough })
      .pipe(Stream.runCollect);
    assert.deepEqual(
      Array.from(repeated, (stored) =>
        stored.event.type === "subagent.updated" ? stored.event.payload.prompt : null,
      ),
      ["Review prompt A. ".repeat(40)],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the anchor a retained stream head borrows from", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune-head");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    yield* sink.write({ events: subagentEvents(threadId, now, 0) });
    // The stream's newest row borrows prompt A, so it is kept below the boundary.
    yield* sink.write({ events: subagentEvents(threadId, now, 0, "repeat") });
    yield* maintenance.pruneEventStore();
    yield* TestClock.adjust("1 day");
    assert.isAbove((yield* maintenance.pruneEventStore()).deletedEventCount, 0);

    assert.include(
      yield* remainingEventIds(threadId),
      "event:turn-item-compaction:subagent-item:0",
    );
    const stored = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
    const head = Array.from(stored).at(-1)?.event;
    assert.deepEqual(
      head?.type === "turn-item.updated" && head.payload.type === "subagent"
        ? head.payload.prompt
        : null,
      "Review prompt A. ".repeat(40),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps an anchor that a row appended during the pass borrows from", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:prune-race");
      yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
      yield* sink.write({ events: subagentEvents(threadId, now, 0) });
      yield* maintenance.pruneEventStore();
      yield* sink.write({ events: [itemEvent(threadId, now, itemSpecs[0], 0)] });
      yield* TestClock.adjust("1 day");

      const scanStarted = yield* Deferred.make<void>();
      const releaseScan = yield* Deferred.make<void>();
      let blocked = false;
      const blockFirstScanPage: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (!blocked && query.includes("END AS prunable")) {
          blocked = true;
          return Deferred.succeed(scanStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseScan)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const pass = yield* maintenance
        .pruneEventStore()
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, blockFirstScanPage),
          Effect.forkScoped,
        );
      yield* Deferred.await(scanStarted);
      yield* sink.write({ events: subagentEvents(threadId, now, 0, "late") });
      yield* Deferred.succeed(releaseScan, undefined);
      assert.equal((yield* Fiber.join(pass)).deletedEventCount, 0);

      const late = yield* eventStore
        .read({ threadId, eventType: "subagent.updated" })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        Array.from(late, (stored) =>
          stored.event.type === "subagent.updated" ? stored.event.payload.prompt : null,
        ),
        ["Review prompt A. ".repeat(40), "Review prompt A. ".repeat(40)],
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

function retentionItems(
  threadId: ThreadId,
  now: DateTime.Utc,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const base = (key: string, ordinal: number) => ({
    id: TurnItemId.make(`turn-item:${threadId}:${key}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: key,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  return [
    {
      ...base("question", 1),
      type: "user_message",
      messageId: MessageId.make(`message:${threadId}:question`),
      inputIntent: "turn_start",
      text: "What changed?",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    { ...base("command", 2), type: "command_execution", input: "ls", output: "a\nb", exitCode: 0 },
    { ...base("reasoning", 3), type: "reasoning", text: "Thinking it over", streaming: false },
    {
      ...base("edit", 4),
      type: "file_change",
      fileName: "a.ts",
      additions: 1,
      deletions: 0,
      diffStr: "+const a = 1;",
    },
    {
      ...base("tool", 5),
      type: "dynamic_tool",
      toolName: "read",
      input: { path: "a" },
      output: "x",
    },
    {
      ...base("sent", 6),
      type: "dynamic_tool",
      toolName: "send_to_user",
      input: { message: "Look" },
      output: { sentMessage: "Look" },
    },
    { ...base("running", 7), status: "running", type: "reasoning", text: "Still", streaming: true },
    {
      ...base("answer", 8),
      type: "assistant_message",
      messageId: MessageId.make(`message:${threadId}:answer`),
      text: "It changed a.ts",
      streaming: false,
    },
  ];
}

const writeRetentionThread = Effect.fn(function* (threadId: ThreadId, unarchive: boolean) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const thread = makeThread(threadId, now);
  const event = (
    key: string,
    type: "thread.archived" | "thread.unarchived",
    archivedAt: DateTime.Utc | null,
  ) =>
    ({
      id: EventId.make(`event:${threadId}:${key}`),
      type,
      threadId,
      occurredAt: now,
      payload: { ...thread, archivedAt },
    }) satisfies OrchestrationV2DomainEvent;
  yield* sink.write({
    events: [
      { ...threadCreated(thread, now), id: EventId.make(`event:${threadId}:created`) },
      ...retentionItems(threadId, now).map(
        (payload) =>
          ({
            id: EventId.make(`event:${threadId}:${payload.title}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload,
          }) satisfies OrchestrationV2DomainEvent,
      ),
      event("archived", "thread.archived", now),
      ...(unarchive ? [event("unarchived", "thread.unarchived", null)] : []),
    ],
  });
});

const storedPayloads = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly source: string; readonly title: string; readonly payload: string }>`
      SELECT 'projection' AS source, json_extract(payload_json, '$.title') AS title,
        payload_json AS payload
      FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
      UNION ALL
      SELECT 'event', json_extract(payload_json, '$.title'), payload_json
      FROM orchestration_events
      WHERE stream_id = ${threadId} AND event_type = 'turn-item.updated'
      ORDER BY 1, 2
    `,
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> })),
    ),
  );

it.effect("drops tool details of threads archived for 14 days and keeps their conversation", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const replay = yield* ProjectionReplay.ProjectionReplay;
    const archived = ThreadId.make("thread:retention-archived");
    const unarchived = ThreadId.make("thread:retention-unarchived");
    yield* writeRetentionThread(archived, false);
    yield* writeRetentionThread(unarchived, true);
    const before = yield* storedPayloads(archived);
    const unarchivedBefore = yield* storedPayloads(unarchived);

    yield* TestClock.adjust("13 days");
    assert.equal((yield* maintenance.trimPayloads()).trimmedThreadCount, 0);
    assert.deepEqual(yield* storedPayloads(archived), before);

    yield* TestClock.adjust("2 days");
    assert.deepEqual(yield* maintenance.trimPayloads(), {
      truncatedOutputCount: 0,
      trimmedThreadCount: 1,
      trimmedItemCount: 4,
    });
    const trimmed = yield* storedPayloads(archived);
    const expected = before.map(({ source, title, payload }) => {
      const removed: Record<string, unknown> = { ...payload, detailsRemoved: true };
      switch (title) {
        case "command":
          delete removed.output;
          return { source, title, payload: removed };
        case "tool":
          delete removed.output;
          return { source, title, payload: { ...removed, input: null } };
        case "reasoning":
          return { source, title, payload: { ...removed, text: "" } };
        case "edit":
          delete removed.diffStr;
          return { source, title, payload: removed };
        default:
          return { source, title, payload };
      }
    });
    assert.deepEqual(trimmed, expected);
    assert.deepEqual(yield* storedPayloads(unarchived), unarchivedBefore);
    // The server's read path still decodes the trimmed items.
    const projection = yield* projections.getThreadProjection(archived);
    assert.include(JSON.stringify(projection), '"detailsRemoved":true');

    assert.deepEqual(yield* maintenance.trimPayloads(), {
      truncatedOutputCount: 0,
      trimmedThreadCount: 0,
      trimmedItemCount: 0,
    });
    assert.deepEqual(yield* storedPayloads(archived), trimmed);

    // Replaying the remaining events neither fails nor brings the details back.
    assert.isTrue((yield* replay.rebuild).valid);
    assert.deepEqual(yield* storedPayloads(archived), trimmed);
    assert.deepEqual(yield* storedPayloads(unarchived), unarchivedBefore);
    assert.equal((yield* maintenance.trimPayloads()).trimmedThreadCount, 1);
    assert.deepEqual(yield* storedPayloads(archived), trimmed);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("truncates long command output as it is written and once for older rows", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:truncation");
    const head = "h".repeat(16 * 1024);
    const tail = "t".repeat(16 * 1024);
    const withOutput = (key: string, output: string) =>
      ({
        id: EventId.make(`event:truncation:${key}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...retentionItems(threadId, now)[1]!,
          id: TurnItemId.make(`turn-item:truncation:${key}`),
          title: key,
          output,
        } as OrchestrationV2TurnItem,
      }) satisfies OrchestrationV2DomainEvent;
    const middle = "m".repeat(COMMAND_OUTPUT_LIMIT - head.length - tail.length);
    const limit = head + middle + tail;
    const over = `${head}${middle}m${tail}`;
    yield* sink.write({
      events: [
        threadCreated(makeThread(threadId, now), now),
        withOutput("limit", limit),
        withOutput("over", over),
      ],
    });
    const truncated = `${head}\n\n[… 32,769 characters removed: the full output was 65,537 characters …]\n\n${tail}`;
    const outputs = () =>
      sql<{ readonly title: string; readonly output: string }>`
        SELECT json_extract(payload_json, '$.title') AS title,
          json_extract(payload_json, '$.output') AS output
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
        UNION ALL
        SELECT json_extract(payload_json, '$.title'), json_extract(payload_json, '$.output')
        FROM orchestration_events
        WHERE stream_id = ${threadId} AND event_type = 'turn-item.updated'
      `.pipe(
        // Compare by identity, not content: a failing diff of 64 KiB strings is unreadable.
        Effect.map((rows) =>
          rows
            .map(
              (row) =>
                `${row.title}:${row.output === limit ? "limit" : row.output === truncated ? "truncated" : row.output.length}`,
            )
            .sort(),
        ),
      );
    const expected = ["limit:limit", "limit:limit", "over:truncated", "over:truncated"];
    assert.deepEqual(yield* outputs(), expected);

    // Rows written before truncation existed.
    yield* sql`
      UPDATE orchestration_v2_projection_turn_items
      SET payload_json = json_set(payload_json, '$.output', ${over})
      WHERE json_extract(payload_json, '$.title') = 'over'
    `;
    yield* sql`
      UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.output', ${over})
      WHERE json_extract(payload_json, '$.title') = 'over'
    `;
    assert.equal((yield* maintenance.trimPayloads()).truncatedOutputCount, 1);
    assert.deepEqual(yield* outputs(), expected);
    assert.equal((yield* maintenance.trimPayloads()).truncatedOutputCount, 0);
  }).pipe(Effect.provide(layerTest)),
);
