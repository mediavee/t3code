const AGENT_EMAILS = new Set([
  "noreply@anthropic.com",
  "claude@anthropic.com",
  "noreply@openai.com",
  "codex@openai.com",
  "cursoragent@cursor.com",
  "copilot@github.com",
  "noreply@github.com",
]);

const GENERATED_BY_AGENT =
  /^(?:🤖\s*)?generated (?:with|by)\s+(?:claude(?: code)?|codex|cursor|github copilot|copilot|opencode|grok|antigravity)[.!]?$/i;
// Cursor's PR footer, plain or linked to cursor.com.
const MADE_WITH_CURSOR = /^made with cursor[.!]?$/i;

const CO_AUTHOR_PREFIX = /^co-authored-by:/i;

function isAgentAuthor(text: string): boolean {
  const prefix = CO_AUTHOR_PREFIX.exec(text);
  if (prefix === null || !text.endsWith(">")) return false;
  const emailStart = text.lastIndexOf("<");
  if (emailStart < prefix[0].length) return false;
  const email = text.slice(emailStart + 1, -1).toLowerCase();
  if (!AGENT_EMAILS.has(email)) return false;
  // GitHub's generic noreply address is also used by people; require Copilot's name.
  return (
    email !== "noreply@github.com" ||
    /^(?:github )?copilot$/i.test(text.slice(prefix[0].length, emailStart).trim())
  );
}

const AGENT_LINK =
  /\[([^[\]\r\n]+)\]\(https:\/\/(?:claude\.ai|claude\.com|www\.anthropic\.com|chatgpt\.com|openai\.com|cursor\.com|github\.com|opencode\.ai|x\.ai|antigravity\.google)(?:\/[^\s)[\]]*)?\)/gi;
const CURSOR_LINK = /\[([^[\]\r\n]+)\]\(https:\/\/(?:www\.)?cursor\.com(?:\/[^\s)[\]]*)?\)/gi;

function isCreditLine(line: string): boolean {
  const text = line.trim().replace(/^(?:[-*]\s+)/, "");
  return (
    isAgentAuthor(text) ||
    GENERATED_BY_AGENT.test(text.replace(AGENT_LINK, "$1")) ||
    MADE_WITH_CURSOR.test(text.replace(CURSOR_LINK, "$1"))
  );
}

const newlineOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

export function removeAgentCredits(message: string): string {
  let fence: string | undefined;
  let removed = false;
  const newline = newlineOf(message);
  const lines = message.split(/\r?\n/).filter((line) => {
    if (/^(?: {4}|\t)/.test(line)) return true;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = delimiter?.[1];
    const remainder = delimiter?.[2] ?? "";
    if (marker !== undefined) {
      if (fence === undefined) {
        if (marker[0] === "~" || !remainder.includes("`")) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(remainder)
      ) {
        fence = undefined;
      }
      return true;
    }
    if (fence !== undefined) return true;
    if (!isCreditLine(line)) return true;
    removed = true;
    return false;
  });
  if (!removed) return message;
  while (lines.length > 1 && /^[ \t]*$/.test(lines.at(-1)!)) {
    lines.pop();
  }
  return lines.join(newline);
}

/**
 * A PR description keeps its own Markdown: only the credit lines that end it go, with the
 * blank lines between them. A commit message uses `removeAgentCredits`.
 */
export function removeAgentCreditFooter(body: string): string {
  const lines = body.split(/\r?\n/);
  let end = lines.length;
  let removed = false;
  while (end > 0) {
    const line = lines[end - 1]!;
    if (/^[ \t]*$/.test(line)) {
      end -= 1;
      continue;
    }
    if (/^(?: {4}|\t)/.test(line) || !isCreditLine(line)) break;
    end -= 1;
    removed = true;
  }
  if (!removed) return body;
  return lines.slice(0, end).join(newlineOf(body));
}
