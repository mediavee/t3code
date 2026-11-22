import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** Command output longer than this many characters keeps only its head and tail. */
export const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const COMMAND_OUTPUT_HEAD = 16 * 1024;
const COMMAND_OUTPUT_TAIL = 16 * 1024;
const MARKER_START = "\n\n[… ";
const MARKER_END = " characters …]\n\n";

/** Keeps the head and tail of a long output, with a marker that gives the original size. */
export function truncateCommandOutput(output: string): string {
  if (output.length <= COMMAND_OUTPUT_LIMIT) return output;
  const removed = output.length - COMMAND_OUTPUT_HEAD - COMMAND_OUTPUT_TAIL;
  return (
    output.slice(0, COMMAND_OUTPUT_HEAD) +
    `${MARKER_START}${removed.toLocaleString("en-US")} characters removed: the full output was ` +
    `${output.length.toLocaleString("en-US")}${MARKER_END}` +
    output.slice(-COMMAND_OUTPUT_TAIL)
  );
}

/** Whether `truncateCommandOutput` cut this output: its marker sits between the kept head and tail. */
export function isTruncatedCommandOutput(output: string): boolean {
  return (
    output.startsWith(MARKER_START, COMMAND_OUTPUT_HEAD) &&
    output.startsWith(MARKER_END, output.length - COMMAND_OUTPUT_TAIL - MARKER_END.length)
  );
}

export function withTruncatedCommandOutput(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "command_execution" || item.output === undefined) return item;
  const output = truncateCommandOutput(item.output);
  return output === item.output ? item : { ...item, output };
}
