import { describe, expect, it } from "vite-plus/test";

import {
  knownSecretValues,
  redactSecrets,
  redactSecretsInValue,
  SecretRedactionStream,
} from "./secretRedaction.ts";

const FAKE = "fake-secret-0000";
const KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "ZmFrZS1rZXktbm90LXJlYWw=",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const MASKED_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "[redacted]",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

function streamed(chunks: ReadonlyArray<string>, known: ReadonlyArray<string> = []) {
  const stream = new SecretRedactionStream();
  return chunks.map((chunk) => stream.push(chunk, known)).join("") + stream.end(known);
}

describe("redactSecrets", () => {
  it.each([
    ["a known value", `DB_PASSWORD=${FAKE}\n`, `DB_PASSWORD=[redacted]\n`],
    ["every occurrence", `${FAKE} and ${FAKE}`, "[redacted] and [redacted]"],
    ["a private key block", `key:\n${KEY}\ndone`, `key:\n${MASKED_KEY}\ndone`],
    [
      "a URL password",
      "amqp://guest:not-a-real-password@rabbit:5672/vhost",
      "amqp://guest:[redacted]@rabbit:5672/vhost",
    ],
    [
      "a URL password with no user",
      "redis://:fake-pass@cache:6379",
      "redis://:[redacted]@cache:6379",
    ],
    [
      "a code sample with a password assignment",
      'const password = "x";\npassword=example\nhttps://example.com/path',
      'const password = "x";\npassword=example\nhttps://example.com/path',
    ],
    ["a URL without a password", "https://user@example.com", "https://user@example.com"],
    ["a long token, in linear time", "x".repeat(200_000), "x".repeat(200_000)],
    [
      "repeated unclosed key headers, in linear time",
      "-----BEGIN RSA PRIVATE KEY-----\n".repeat(20_000),
      "-----BEGIN RSA PRIVATE KEY-----\n".repeat(20_000),
    ],
    [
      "repeated headers that are not keys, in linear time",
      "-----BEGIN BUILD LOG-----\n".repeat(20_000),
      "-----BEGIN BUILD LOG-----\n".repeat(20_000),
    ],
    [
      "two key blocks and the text between them",
      `${KEY}\nmiddle\n${KEY}`,
      `${MASKED_KEY}\nmiddle\n${MASKED_KEY}`,
    ],
  ])("masks %s", (_name, text, expected) => {
    expect(redactSecrets(text, [FAKE])).toBe(expected);
  });

  it("ignores values too short to mask safely and keeps the trimmed form", () => {
    expect(knownSecretValues(["short", ` ${FAKE}\n`])).toEqual([` ${FAKE}\n`, FAKE]);
  });

  it("masks strings inside structured output and keeps the rest", () => {
    const output = { content: [{ type: "text", text: `token ${FAKE}` }], isError: false };
    expect(redactSecretsInValue(output, [FAKE])).toEqual({
      content: [{ type: "text", text: "token [redacted]" }],
      isError: false,
    });
    const clean = { content: [{ type: "text", text: "nothing here" }] };
    expect(redactSecretsInValue(clean, [FAKE])).toBe(clean);
  });
});

describe("SecretRedactionStream", () => {
  it.each([
    [
      "a known value split across chunks",
      ["export TOKEN=fake-sec", "ret-0000\nok\n"],
      "export TOKEN=[redacted]\nok\n",
    ],
    [
      "a private key split across chunks",
      [`a\n${KEY.slice(0, 20)}`, `${KEY.slice(20)}\nb`],
      `a\n${MASKED_KEY}\nb`,
    ],
    [
      "a URL password split across chunks",
      ["mysql://root:fake-pa", "ss@db:3306\n"],
      "mysql://root:[redacted]@db:3306\n",
    ],
    ["text with nothing to hold", ["one\n", "two\n"], "one\ntwo\n"],
    [
      "a long token, in linear time",
      ["y".repeat(100_000), "y".repeat(100_000)],
      "y".repeat(200_000),
    ],
  ])("masks %s", (_name, chunks, expected) => {
    expect(streamed(chunks, [FAKE])).toBe(expected);
  });

  it.each([
    [
      "whose last character is its first",
      ["xfake-secret-000x", " ok\n"],
      ["xfake-secret-000x"],
      "[redacted] ok\n",
    ],
    [
      "ending like a URL scheme",
      ["fake_access_token:", " ok\n"],
      ["fake_access_token:"],
      "[redacted] ok\n",
    ],
    [
      "overlapping another one",
      ["fake-secret-AAAA-BBBB", " ok\n"],
      ["fake-secret-AAAA", "AAAA-BBBB-fake"],
      "[redacted]-BBBB ok\n",
    ],
  ])("never lets part of a complete secret %s through", (_name, chunks, known, expected) => {
    expect(streamed(chunks, known)).toBe(expected);
  });

  it("keeps output flowing after a header that is not a private key", () => {
    const stream = new SecretRedactionStream();
    expect(stream.push("-----BEGIN BUILD LOG-----\n", [])).toBe("-----BEGIN BUILD LOG-----\n");
    for (let i = 0; i < 100; i++) expect(stream.push(`line ${i}\n`, [])).toBe(`line ${i}\n`);
    expect(stream.push("x -----BEGIN ", [])).toBe("x ");
    expect(stream.push("BUILD LOG\n", [])).toBe("-----BEGIN BUILD LOG\n");
  });

  it("finds an end marker split across chunks after a key too long to hold", () => {
    const body = "A".repeat(64 * 1024);
    const end = "-----END RSA PRIVATE KEY-----";
    const out = streamed([
      `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${end.slice(0, 12)}`,
      `${end.slice(12)}\nafter\n`,
    ]);
    expect(out).toBe(`-----BEGIN RSA PRIVATE KEY-----\n[redacted]\n${end}\nafter\n`);
  });

  it("releases held text unmasked once masking is turned off", () => {
    const stream = new SecretRedactionStream();
    expect(stream.push("value fake-sec", [FAKE])).toBe("value ");
    expect(stream.release()).toBe("fake-sec");
    expect(stream.end([FAKE])).toBe("");
  });

  it("releases held text that turned out not to be a secret", () => {
    const stream = new SecretRedactionStream();
    expect(stream.push("value fake-sec", [FAKE])).toBe("value ");
    expect(stream.push("tion\n", [FAKE])).toBe("fake-section\n");
  });

  it("masks a private key that never ends", () => {
    expect(streamed([`${KEY.slice(0, 50)}`])).toBe(
      "-----BEGIN OPENSSH PRIVATE KEY-----\n[redacted]",
    );
  });
});
