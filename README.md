# clauth-freebuff-proxy

**Spend freebuff's free tier from Claude Code: eight models, each account on its own pasted token.**

A clauth proxy built on `clauth-proxy-core`. It runs headless: clauth enables it, supervises it and holds its log.

> [!WARNING]
> freebuff's upstream says free mode is CLI-only and that direct API use may get accounts banned. This proxy impersonates the freebuff CLI's wire, as the other clauth proxies impersonate theirs. The deepseek models and `minimax/minimax-m3` train on your data. Use it at your own risk.

## What it is

Claude Code speaks Anthropic's `/v1/messages`; freebuff speaks an OpenAI-shaped chat wire behind a session per account and model, and an agent run per chat. The proxy sits between them on a loopback port: it answers the Anthropic request, dials freebuff with the CLI's own headers, and returns the answer as an Anthropic message or SSE stream.

## Models

Each model below ships, mapped onto its freebuff agent. Any other model id answers `invalid_request`.

| model | tier | trains on data |
|---|---|---|
| `minimax/minimax-m2.7` | free | no |
| `minimax/minimax-m3` | free | yes |
| `deepseek/deepseek-v4-flash` | free | yes |
| `mimo/mimo-v2.5` | free | no |
| `google/gemini-3.1-flash-lite-preview` | free | no |
| `deepseek/deepseek-v4-pro` | limited | yes |
| `mimo/mimo-v2.5-pro` | limited | no |
| `moonshotai/kimi-k2.6` | limited | no |

`free` models are the unlimited tier; `limited` models draw on the daily one-hour session pool. The upstream keeps that quota server-side and exposes only the live session's remaining time, so nothing here reports it.

Training flags are informational: a training model is served like any other. Set the model in the clauth profile (or the request) by its canonical id; short aliases resolve too (`deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3.1-terminus` for the v4-pro, `mimo-v2.5-pro`, `mimo-v2.5`, `kimi-k2.6`, `minimax-m2.7`, `minimax-m3`, `gemini-3.1-flash-lite`). `claude-haiku-4-5`, the model `clauth proxy check` sends, resolves to `minimax/minimax-m2.7`.

## How it works

| stage | what happens |
|---|---|
| login | the account's freebuff auth token is pasted; a GET on the streak route validates it, with no side effect upstream |
| session | one `POST /api/v1/freebuff/session` per account and model, cached until its expiry, polled while the upstream queues it; a 404 means the upstream runs sessionless and the chat proceeds without one |
| run | an agent run `START`s per chat and `FINISH`es once the answer is fully sent (on a stream, after the last byte) |
| chat | the converted body carries `codebuff_metadata` (`run_id`, `client_id`, `trace_session_id`, `cost_mode: "free"`, and `freebuff_instance_id` when a session exists) and `provider.data_collection: "deny"` |
| retries | one retry per error class: a dead run id, an invalidated session (426), a session bound to another model |
| pacing | the account's chat requests are at least `request_gap_ms` apart, the gap the freebuff client itself keeps |

## Install

Requires bun 1.3 or newer.

```sh
bun install
bun build --compile --outfile clauth-freebuff-proxy src/index.ts
install -m 755 clauth-freebuff-proxy ~/.local/bin/
```

The compiled binary is `clauth-freebuff-proxy` on `PATH`, which is how clauth discovers a proxy.

## Usage

```sh
clauth proxy list
clauth proxy enable freebuff
```

`list` finds the binary on `PATH`, one row per discovered proxy:

```text
SERVICE   VERSION  CONTRACT  ENABLED  PORT  STATE
freebuff  0.0.0    1.0       false       -  not_registered
```

`enable` picks a free loopback port, mints the admin token, writes the row to `~/.clauth/proxies.toml` and has the daemon run the proxy. `clauth proxy disable freebuff` stops it and keeps its port, token and state directory.

### Add an account

Login is paste-only. Sign in at <https://freebuff.llm.pm> once with GitHub and copy the auth token the page hands you; the freebuff CLI's own `~/.config/manicode/credentials.json` carries the same token under `data.default.authToken`. Then paste it through the proxy's control API:

```sh
PORT=$(clauth proxy list --json | jq -r '.[] | select(.service == "freebuff") | .port')
ADMIN=$(cat ~/.clauth/proxies/freebuff/clauth-admin-token)
FLOW=$(curl -sS -X POST "http://127.0.0.1:$PORT/clauth/v1/accounts/login" \
  -H "Authorization: Bearer $ADMIN" | jq -r .flow)
curl -sS -X POST "http://127.0.0.1:$PORT/clauth/v1/accounts/login/$FLOW" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"code":"<auth-token>"}' | jq '{state, label: .account.label, inference_key}'
```

The paste answers `state: "done"` with the account and its inference key. The key is shown once; the proxy stores only its hash. Point Claude Code at the proxy with that key:

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"
export ANTHROPIC_AUTH_TOKEN="<inference-key>"
```

## Configuration

`clauth-freebuff-proxy serve` reads:

| env | meaning |
|---|---|
| `CLAUTH_PROXY_BIND` | `host:port` to bind; loopback only (`127.0.0.1`, `::1` or `localhost`) |
| `CLAUTH_PROXY_STATE_DIR` | state directory, created `0700` |
| `CLAUTH_PROXY_ADMIN_TOKEN_FILE` | file holding the admin token |
| `FREEBUFF_UPSTREAM_BASE_URL` | optional; upstream origin, default `https://www.codebuff.com` (a schemeless value dials https, and a bare `codebuff.com` normalizes to `www.`) |

clauth supplies the first three. One account setting is declared, one action, two figures:

| surface | id | what it is |
|---|---|---|
| setting | `request_gap_ms` | minimum milliseconds between the account's chat requests; default `1300`, range 0 to 60000, step 100 |
| action | `end-session` | ends every upstream session the account holds and forgets them; asks for confirmation |
| figure | `session` | percent of the current one-hour upstream session used and when it resets; absent with no active session |
| figure | `stats` | the proxy's own request counters for the process lifetime (attempted, succeeded, failed, cancelled, mean latency, tokens), so a restart restarts them |

`count_tokens` answers locally as `ceil(chars / 4)` over the request's text parts, system and tool results included, with no upstream call.

## Development

```sh
bun run check             # tsc --noEmit && bun test
bun run check:conformance # drives `clauth proxy check` against a stub upstream, in safe and --destructive modes
bun run check:parity      # compares the proxy's upstream requests against the shapes pinned in scripts/parity-core.ts
```

The conformance run needs the `clauth` binary at `CLAUTH_BIN` or `~/.cargo/bin/clauth`.

## What it leaves out

- No browser login, no poll door: the token is pasted.
- No ads, streak reporting, agent validation or WARP: the upstream requires none of them for chat.
- No quota of its own: the session figure reads the upstream session, and no other number is invented.
- No UI of its own: the proxy serves the contract and nothing else.
