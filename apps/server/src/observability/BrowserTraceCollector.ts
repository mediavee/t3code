import type { OtlpTraceRecord, TraceRecord, TraceSink } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// External OTLP forwarding sends the raw batch; local NDJSON keeps only compact identity attributes.
const COMPACT_BROWSER_RESOURCE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "service.name",
  "service.version",
  "service.instance.id",
  "t3code.client.surface",
  "t3code.release.channel",
  "browser.mobile",
]);

function compactLocalResourceAttributes(
  resourceAttributes: OtlpTraceRecord["resourceAttributes"],
): OtlpTraceRecord["resourceAttributes"] {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resourceAttributes)) {
    if (COMPACT_BROWSER_RESOURCE_ATTRIBUTE_KEYS.has(key)) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function compactLocalTraceRecord(record: TraceRecord): TraceRecord {
  if (record.type !== "otlp-span") {
    return record;
  }
  return {
    ...record,
    resourceAttributes: compactLocalResourceAttributes(record.resourceAttributes),
  };
}

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  {
    readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
  }
>()("t3/observability/BrowserTraceCollector") {}

/** @public */
export const make = (sink: TraceSink): BrowserTraceCollector["Service"] =>
  BrowserTraceCollector.of({
    record: Effect.fn("BrowserTraceCollector.record")(function (records) {
      return Effect.sync(() => {
        for (const record of records) {
          sink.push(compactLocalTraceRecord(record));
        }
      });
    }),
  });

export const layer = (sink: TraceSink) => Layer.succeed(BrowserTraceCollector, make(sink));
