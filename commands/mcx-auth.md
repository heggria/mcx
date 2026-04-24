---
allowed-tools: Bash(mcx:*), Bash(command:*), Bash(~/.bun/bin/mcx:*)
description: Manage authentication for mcx backends — store static tokens, run OAuth 2.1 flows, list/remove credentials. Tokens are encrypted at rest.
argument-hint: set <server> --token X | login <server> | list | rm <server>
---

mcx supports three auth modes per backend (declared in `backends.toml`):

| `kind` in toml | How to authenticate | Storage |
|---|---|---|
| `header` (custom header) | `mcx auth set <server> --token <X>` | encrypted in catalog.db |
| `bearer` (Authorization: Bearer) | `mcx auth set <server> --token <X>` | encrypted in catalog.db |
| `oauth` (OAuth 2.1 + PKCE + DCR) | `mcx auth login <server>` (opens browser) | encrypted; access + refresh + expires_at |

## Static token (header / bearer)

```bash
mcx --json auth set <server> --token <token-value>
```

Token is AES-256-GCM encrypted with a key derived from machine-id + per-install salt.

## OAuth 2.1 login

```bash
mcx --json auth login <server>
```

What happens:
1. Discover authorization + token + registration endpoints (`/.well-known/oauth-authorization-server`)
2. Register a public client via DCR if not cached
3. Generate PKCE S256 challenge
4. Spin up a local callback server on `127.0.0.1:7654`
5. Open the user's browser to the authorization endpoint
6. User clicks approve in browser → redirect to local callback with `code` + `state`
7. Exchange code for access + refresh token
8. Store the token set encrypted

If the browser doesn't auto-open, the URL is printed to stderr — paste it manually.

To force re-registration (e.g. token revoked server-side):

```bash
mcx --json auth login <server> --reset
```

## List stored tokens

```bash
mcx --json auth list
```

Shows servers, `created_at`, and `last_used` (when token was last decrypted).

## Remove a token

```bash
mcx --json auth rm <server>
```

Also removes the OAuth client registration if present.

## Env var override (for CI / scripts)

```bash
export MCX_TOKEN_FEISHU_PROJECT=m-xxx
```

Env vars take precedence over the encrypted store. Naming: uppercase server name, dashes → underscores.

## Token expiry & refresh

OAuth tokens are auto-refreshed on use when within 60s of `expires_at`. If refresh fails (server-side revoke, refresh token expired), the next `mcx call` will warn and you'll need to re-run `mcx auth login <server>`.
