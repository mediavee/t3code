import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** Masks secrets in tool and command output: exact known values and two unmistakable shapes. */

const REDACTED = "[redacted]";
/** Shorter values match too much ordinary text to mask safely. */
const MIN_KNOWN_SECRET_LENGTH = 8;

const PEM_BEGIN = "-----BEGIN ";
const PEM_PRIVATE_KEY =
  /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
const PEM_OPEN = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----(?![\s\S]*-----END \1PRIVATE KEY-----)/;
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

export function redactSecrets(text: string, known: ReadonlyArray<string>): string {
  let result = text;
  for (const value of known) {
    if (result.includes(value)) result = result.split(value).join(REDACTED);
  }
  return result
    .replace(
      PEM_PRIVATE_KEY,
      (_block, kind: string) =>
        `-----BEGIN ${kind}PRIVATE KEY-----\n${REDACTED}\n-----END ${kind}PRIVATE KEY-----`,
    )
    .replace(URL_PASSWORD, `$1${REDACTED}@`);
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

/**
 * Masks output that arrives in chunks. Text that may be the start of a secret is held back
 * until the next chunk shows whether it is one, so a value split across chunks is still masked.
 */
export class SecretRedactionStream {
  private held = "";
  /** A private key too long to hold is dropped until its end marker. */
  private droppingKey: string | null = null;

  push(chunk: string, known: ReadonlyArray<string>): string {
    let text = this.held + chunk;
    this.held = "";
    let prefix = "";
    if (this.droppingKey !== null) {
      const end = `-----END ${this.droppingKey}PRIVATE KEY-----`;
      const at = text.indexOf(end);
      if (at === -1) {
        // Keep what may be the start of the end marker.
        this.held = text.slice(-(end.length - 1));
        return "";
      }
      prefix = `\n${end}`;
      text = text.slice(at + end.length);
      this.droppingKey = null;
    }
    const cut = text.length - this.holdLength(text, known);
    this.held = text.slice(cut);
    const open = PEM_OPEN.exec(this.held);
    if (open !== null && this.held.length > MAX_PEM_HOLD) {
      const header = this.held.slice(0, open.index + open[0].length);
      this.held = "";
      this.droppingKey = open[1] ?? "";
      return prefix + redactSecrets(text.slice(0, cut) + header, known) + `\n${REDACTED}`;
    }
    return prefix + redactSecrets(text.slice(0, cut), known);
  }

  /** Releases what is still held once the output ends. */
  end(known: ReadonlyArray<string>): string {
    const text = this.held;
    this.held = "";
    if (this.droppingKey !== null) {
      this.droppingKey = null;
      return "";
    }
    const open = PEM_OPEN.exec(text);
    if (open !== null) {
      return redactSecrets(text.slice(0, open.index + open[0].length), known) + `\n${REDACTED}`;
    }
    return redactSecrets(text, known);
  }

  private holdLength(text: string, known: ReadonlyArray<string>): number {
    let hold = 0;
    for (const value of known) hold = Math.max(hold, partialSuffix(text, value));
    const open = PEM_OPEN.exec(text);
    if (open !== null) hold = Math.max(hold, text.length - open.index);
    hold = Math.max(hold, partialSuffix(text, PEM_BEGIN));
    const beginAt = text.lastIndexOf(PEM_BEGIN);
    // A header still arriving: `-----BEGIN RSA PRIV`.
    if (beginAt !== -1 && !text.includes("-----", beginAt + PEM_BEGIN.length)) {
      hold = Math.max(hold, text.length - beginAt);
    }
    const tail = text.slice(-MAX_URL_HOLD);
    const url = URL_USERINFO_OPEN.exec(tail);
    if (url !== null) hold = Math.max(hold, tail.length - url.index);
    return hold;
  }
}

/** Masks a command's or tool's output; `known` is null while masking is off. */
export function redactTurnItemOutput<Item extends OrchestrationV2TurnItem>(
  item: Item,
  known: ReadonlyArray<string> | null,
): Item {
  if (known === null || !("output" in item) || item.output === undefined) return item;
  if (item.type !== "command_execution" && item.type !== "dynamic_tool") return item;
  const output = redactSecretsInValue(item.output, known);
  return output === item.output ? item : { ...item, output };
}
