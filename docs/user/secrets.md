# Secrets

Keep credentials in 1Password instead of storing raw values in T3 Code, and let agents request one-off secrets in a private card instead of chat history.

> Note: **Settings → Secrets** is in preview and may not appear in every build. In-thread secret request cards from agents work everywhere.

## Connect 1Password

Install and sign in to the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) on the **T3 Code server machine**. On headless or remote servers, use a [1Password service account](./secrets-1password-service-account.md) or [1Password Connect](./secrets-1password-connect.md) so `op` doesn't wait for desktop approval.

1. Open **Settings → Secrets → Add provider** (configured per environment).
2. Enter a name and the 1Password account shorthand, sign-in address (without `https://`), or ID from `op account list`.

## Use secret references

Credential fields in Settings (provider env vars, source control tokens, usage keys, device host tokens) include a source picker: choose **Value** for a literal value or select your 1Password provider and paste a reference like `op://vault/item/field`.

- Click the check button to verify a reference immediately.
- T3 Code reads secrets on demand (e.g. when starting a provider). If 1Password is locked, unlock it on the server and click **Refresh** in **Settings → Providers**.
- Removing a secret provider clears fields referencing it in T3 Code without touching 1Password.

## When an agent asks for a secret

When an agent calls `request_secret`, T3 Code displays a private card in the thread (web, desktop, and mobile) instead of asking you to paste into chat.

- Enter a value (or pick a 1Password reference if configured and permitted) and click **Save securely**, or **Decline**.
- Values never appear in conversation history. For T3 tools, the secret is passed directly without exposing it to the agent; for shell commands, the card tells you that the value is written to a private temporary file readable by the agent's commands for ~24 hours.

## Secrets in tool output

A command an agent runs can still print a secret, for example `cat .env`. T3 Code replaces these with `[redacted]` in the command and tool output it saves and shows (file and web search results and file edits included), on every device, in the provider event logs, and in the result a task delegated to another environment sends back:

- values you gave through a secret request card, from when you answer until the server restarts (a card field shown in clear, such as an email, is not masked)
- values read from a secret reference, and provider environment variables marked sensitive
- private key blocks (`-----BEGIN … PRIVATE KEY-----`)
- the password in a URL, such as `mysql://user:password@host`

Anything else is not masked: a `password=` line in a config file, a token T3 Code was never given, the agent's own messages, and output saved before the secret was known or while the setting was off. The agent itself still sees the command's real output. Turn masking off in **Settings → Maintenance → Secrets in tool output**.
