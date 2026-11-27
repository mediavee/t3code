import type {
  EffectTraceRecord,
  OtlpTraceRecord,
  TraceRecord,
  TraceSink,
} from "@t3tools/shared/observability";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as BrowserTraceCollector from "./BrowserTraceCollector.ts";

describe("BrowserTraceCollector", () => {
  it.effect("trims bloated browser resource attributes before writing local trace records", () =>
    Effect.gen(function* () {
      const pushed: TraceRecord[] = [];
      const sink: TraceSink = {
        filePath: "/tmp/test.trace.ndjson",
        push: (record) => {
          pushed.push(record);
        },
        flush: Effect.void,
        flushSync: () => undefined,
        close: () => Effect.void,
      };
      const collector = BrowserTraceCollector.make(sink);

      const otlpRecord: OtlpTraceRecord = {
        type: "otlp-span",
        name: "EnvironmentRpc.request",
        kind: "internal",
        traceId: "trace-1",
        spanId: "span-1",
        sampled: true,
        startTimeUnixNano: "1000000",
        endTimeUnixNano: "2000000",
        durationMs: 1,
        attributes: { "rpc.method": "server.getConfig" },
        resourceAttributes: {
          "service.name": "t3code-web",
          "service.version": "0.1.12",
          "service.instance.id": "instance-1",
          "t3code.client.surface": "desktop",
          "t3code.release.channel": "nightly",
          "browser.mobile": false,
          "user_agent.original": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...",
          "browser.brands": ["Chromium 134", "Not:A-Brand 24"],
          "browser.platform": "macOS",
          "telemetry.sdk.name": "effect",
        },
        scope: { name: "t3code-web", attributes: {} },
        events: [],
        links: [],
        status: { code: "0" },
      };

      const effectRecord: EffectTraceRecord = {
        type: "effect-span",
        name: "server.op",
        kind: "internal",
        traceId: "trace-2",
        spanId: "span-2",
        sampled: true,
        startTimeUnixNano: "1000000",
        endTimeUnixNano: "2000000",
        durationMs: 1,
        attributes: {},
        events: [],
        links: [],
        exit: { _tag: "Success" },
      };

      yield* collector.record([otlpRecord, effectRecord]);

      assert.strictEqual(pushed.length, 2);
      assert.deepStrictEqual((pushed[0] as OtlpTraceRecord).resourceAttributes, {
        "service.name": "t3code-web",
        "service.version": "0.1.12",
        "service.instance.id": "instance-1",
        "t3code.client.surface": "desktop",
        "t3code.release.channel": "nightly",
        "browser.mobile": false,
      });
      assert.strictEqual(pushed[1], effectRecord);
    }),
  );
});
