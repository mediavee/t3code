import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** Masks secrets in tool and command output: exact known values and two unmistakable shapes. */

const REDACTED = "[redacted]";
/** Shorter values match too much ordinary text to mask safely. */
const MIN_KNOWN_SECRET_LENGTH = 8;

const PEM_BEGIN = "-----BEGIN ";
const PRIVATE_KEY = "PRIVATE KEY";
const PEM_DASHES = "-----";
const PEM_END_AFTER_MASK = "\n-----END ";
/** Longest key kind before `PRIVATE KEY`, such as `ENCRYPTED ` or `OPENSSH `. */
const MAX_KEY_KIND = 32;
const KEY_KIND_CHARS = /^[A-Z0-9 ]*$/;
/**
 * `scheme://user:password@host`; the user may be empty, the password may not. The lookbehind and
 * bounded scheme keep a long run of letters, such as base64, from backtracking quadratically.
 */
const URL_PASSWORD = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/?#@]*:)[^\s/?#@]+@/gi;
/** A URL whose userinfo may still be arriving. */
const URL_USERINFO_OPEN = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:(?:\/\/[^\s/?#@]*|\/?)$/i;
/** Held text an unfinished URL or key may grow to before it is released or dropped. */
const MAX_URL_HOLD = 512;
const MAX_PEM_HOLD = 64 * 1024;

/** Each value and its trimmed form, long enough to mask, longest first so overlaps mask whole. */
export function knownSecretValues(values: Iterable<string>): string[] {
  const kept = new Set<string>();
  for (const value of values) {
    for (const form of [value, value.trim()]) {
      if (form.length >= MIN_KNOWN_SECRET_LENGTH) kept.add(form);
    }
  }
  return [...kept].sort((a, b) => b.length - a.length);
}

interface KeyHeader {
  readonly start: number;
  /** Index just after the header's closing dashes. */
  readonly end: number;
  readonly endMarker: string;
}

/** The private key header starting at `start`, if one does. */
function keyHeaderAt(text: string, start: number): KeyHeader | undefined {
  const kindStart = start + PEM_BEGIN.length;
  // Searched within the header's bounded length, so many headers stay linear.
  const window = text.slice(
    kindStart,
    kindStart + MAX_KEY_KIND + PRIVATE_KEY.length + PEM_DASHES.length,
  );
  const offset = window.indexOf(PRIVATE_KEY + PEM_DASHES);
  if (offset === -1) return undefined;
  const at = kindStart + offset;
  const kind = text.slice(kindStart, at);
  if (!KEY_KIND_CHARS.test(kind)) return undefined;
  return {
    start,
    end: at + PRIVATE_KEY.length + PEM_DASHES.length,
    endMarker: `-----END ${kind}${PRIVATE_KEY}${PEM_DASHES}`,
  };
}

/**
 * Masks each private key block in one pass. A header with no end marker after it is reported as
 * `open`; once one kind has no end marker, later headers of that kind are not searched again.
 */
function scanPrivateKeys(text: string): {
  readonly text: string;
  readonly open: KeyHeader | undefined;
} {
  let result = "";
  let copied = 0;
  let open: KeyHeader | undefined;
  const unclosed = new Set<string>();
  let from = text.indexOf(PEM_BEGIN);
  while (from !== -1) {
    const header = keyHeaderAt(text, from);
    if (header === undefined) {
      from = text.indexOf(PEM_BEGIN, from + PEM_BEGIN.length);
      continue;
    }
    const close = unclosed.has(header.endMarker) ? -1 : text.indexOf(header.endMarker, header.end);
    if (close === -1) {
      unclosed.add(header.endMarker);
      const shift = result.length - copied;
      open ??= { ...header, start: header.start + shift, end: header.end + shift };
      from = text.indexOf(PEM_BEGIN, header.end);
      continue;
    }
    result += `${text.slice(copied, header.end)}\n${REDACTED}\n${header.endMarker}`;
    copied = close + header.endMarker.length;
    from = text.indexOf(PEM_BEGIN, copied);
  }
  return { text: copied === 0 ? text : result + text.slice(copied), open };
}

/** Masked text and the index just after its last replacement, which nothing may be held across. */
function redactTracked(text: string, known: ReadonlyArray<string>) {
  let result = text;
  for (const value of known) {
    if (result.includes(value)) result = result.split(value).join(REDACTED);
  }
  result = scanPrivateKeys(result).text.replace(
    URL_PASSWORD,
    (_match, userinfo: string) => `${userinfo}${REDACTED}@`,
  );
  const last = result.lastIndexOf(REDACTED);
  if (last === -1) return { text: result, lastEnd: 0 };
  let lastEnd = last + REDACTED.length;
  if (result.startsWith("@", lastEnd)) lastEnd += 1;
  else if (result.startsWith(PEM_END_AFTER_MASK, lastEnd)) {
    const close = result.indexOf(PEM_DASHES, lastEnd + PEM_END_AFTER_MASK.length);
    if (close !== -1) lastEnd = close + PEM_DASHES.length;
  }
  return { text: result, lastEnd };
}

export function redactSecrets(text: string, known: ReadonlyArray<string>): string {
  return redactTracked(text, known).text;
}

/** Masks every string in a tool's structured output, keeping its shape. */
export function redactSecretsInValue(value: unknown, known: ReadonlyArray<string>): unknown {
  if (typeof value === "string") return redactSecrets(value, known);
  if (Array.isArray(value)) {
    let next: unknown[] | undefined;
    value.forEach((entry, index) => {
      const masked = redactSecretsInValue(entry, known);
      if (masked !== entry) (next ??= value.slice())[index] = masked;
    });
    return next ?? value;
  }
  if (typeof value !== "object" || value === null) return value;
  let next: Record<string, unknown> | undefined;
  for (const [key, entry] of Object.entries(value)) {
    const masked = redactSecretsInValue(entry, known);
    if (masked !== entry) (next ??= { ...value })[key] = masked;
  }
  return next ?? value;
}

/** The length of the longest end of `text` that starts `value` without being all of it. */
function partialSuffix(text: string, value: string): number {
  const first = value.charAt(0);
  let at = text.indexOf(first, Math.max(0, text.length - value.length + 1));
  while (at !== -1) {
    if (value.startsWith(text.slice(at))) return text.length - at;
    at = text.indexOf(first, at + 1);
  }
  return 0;
}

/** Whether text after `-----BEGIN ` can still grow into a private key header. */
function couldBecomeKeyHeader(rest: string): boolean {
  if (rest.length > MAX_KEY_KIND + PRIVATE_KEY.length + PEM_DASHES.length - 1) return false;
  const dashes = rest.indexOf("-");
  const kind = dashes === -1 ? rest : rest.slice(0, dashes);
  if (!KEY_KIND_CHARS.test(kind)) return false;
  if (dashes === -1) return true;
  return kind.endsWith(PRIVATE_KEY) && /^-{1,4}$/.test(rest.slice(dashes));
}

/**
 * Masks output that arrives in chunks. Complete secrets are masked first; then text that may be
 * the start of one is held back until the next chunk shows whether it is. Every hold is bounded.
 */
export class SecretRedactionStream {
  private held = "";
  /** A private key too long to hold is dropped until its end marker. */
  private dropping: { readonly endMarker: string; dropped: number } | null = null;

  push(chunk: string, known: ReadonlyArray<string>): string {
    let text = this.held + chunk;
    this.held = "";
    let prefix = "";
    if (this.dropping !== null) {
      const { endMarker } = this.dropping;
      const at = text.indexOf(endMarker);
      if (at === -1) {
        this.dropping.dropped += chunk.length;
        // Past this length it is not a key: drop this chunk and let what follows through.
        if (this.dropping.dropped > MAX_PEM_HOLD) this.dropping = null;
        else this.held = text.slice(-(endMarker.length - 1));
        return "";
      }
      prefix = `\n${endMarker}`;
      text = text.slice(at + endMarker.length);
      this.dropping = null;
    }
    const masked = redactTracked(text, known);
    const open = scanPrivateKeys(masked.text).open;
    const length = masked.text.length;
    if (open !== undefined && (open.start < masked.lastEnd || length - open.start > MAX_PEM_HOLD)) {
      const body = masked.text.slice(open.end);
      this.dropping = { endMarker: open.endMarker, dropped: body.length };
      // The end marker may be split across this chunk and the next.
      this.held = body.slice(-(open.endMarker.length - 1));
      return `${prefix}${masked.text.slice(0, open.end)}\n${REDACTED}`;
    }
    const hold = Math.min(this.holdLength(masked.text, known, open), length - masked.lastEnd);
    this.held = masked.text.slice(length - hold);
    return prefix + masked.text.slice(0, length - hold);
  }

  /** Releases what is held unmasked, for when masking was turned off mid-output. */
  release(): string {
    const text = this.held;
    this.held = "";
    this.dropping = null;
    return text;
  }

  /** Releases what is still held once the output ends. */
  end(known: ReadonlyArray<string>): string {
    const text = this.held;
    this.held = "";
    if (this.dropping !== null) {
      this.dropping = null;
      return "";
    }
    const masked = redactSecrets(text, known);
    const open = scanPrivateKeys(masked).open;
    if (open !== undefined) return `${masked.slice(0, open.end)}\n${REDACTED}`;
    return masked;
  }

  private holdLength(
    text: string,
    known: ReadonlyArray<string>,
    open: KeyHeader | undefined,
  ): number {
    let hold = 0;
    for (const value of known) hold = Math.max(hold, partialSuffix(text, value));
    if (open !== undefined) hold = Math.max(hold, text.length - open.start);
    hold = Math.max(hold, partialSuffix(text, PEM_BEGIN));
    const beginAt = text.lastIndexOf(PEM_BEGIN);
    if (beginAt !== -1 && couldBecomeKeyHeader(text.slice(beginAt + PEM_BEGIN.length))) {
      hold = Math.max(hold, text.length - beginAt);
    }
    const tail = text.slice(-MAX_URL_HOLD);
    const url = URL_USERINFO_OPEN.exec(tail);
    if (url !== null) hold = Math.max(hold, tail.length - url.index);
    return hold;
  }
}

/** Fields that carry what a tool read or produced, by turn item type. */
const OUTPUT_FIELDS: Partial<Record<OrchestrationV2TurnItem["type"], ReadonlyArray<string>>> = {
  command_execution: ["output"],
  dynamic_tool: ["output"],
  file_search: ["results"],
  web_search: ["results", "patterns"],
  file_change: ["diffStr", "oldStr", "newStr"],
};

/** Masks what a tool or command returned; `known` is null while masking is off. */
export function redactTurnItemOutput<Item extends OrchestrationV2TurnItem>(
  item: Item,
  known: ReadonlyArray<string> | null,
): Item {
  if (known === null) return item;
  const fields = OUTPUT_FIELDS[item.type];
  if (fields === undefined) return item;
  let next: Record<string, unknown> | undefined;
  for (const field of fields) {
    const value = (item as Record<string, unknown>)[field];
    if (value === undefined) continue;
    const masked = redactSecretsInValue(value, known);
    if (masked !== value) (next ??= { ...item })[field] = masked;
  }
  return (next as Item | undefined) ?? item;
}
