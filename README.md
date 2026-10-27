# clauth-freebuff-proxy

**Spend freebuff's free tier from Claude Code: the upstream model catalogue, each account on its own browser login.**

A clauth proxy built on `clauth-proxy-core`. It runs headless: clauth enables it, supervises it and holds its log.

<p align="center">
  <img src="https://cov.uwuclxdy.dev/badges/uwuclxdy/clauth-freebuff-proxy/coverage.svg" alt="coverage" />
  <img src="https://cov.uwuclxdy.dev/badges/uwuclxdy/clauth-freebuff-proxy/ratio.svg" alt="code to test ratio" />
  <img src="https://cov.uwuclxdy.dev/badges/uwuclxdy/clauth-freebuff-proxy/time.svg" alt="test execution time" />
  <a href="#license"><img src="https://shields.uwuclxdy.dev/badge/license-MIT%20OR%20Apache--2.0-blue" alt="MIT OR Apache-2.0 license" /></a>
</p>


> [!WARNING]
> freebuff's upstream says free mode is CLI-only and that direct API use may get accounts banned. This proxy impersonates the freebuff CLI's wire, as the other clauth proxies impersonate theirs, including the CLI's system-prompt opening shown under Models. Some catalogue models train on your data. Use it at your own risk.

## What it is

Claude Code speaks Anthropic's `/v1/messages`; freebuff speaks an OpenAI-shaped chat wire behind an agent run per chat and a model catalogue per account. The proxy sits between them on a loopback port: it answers the Anthropic request, dials freebuff with the CLI's own headers and prompt opening, and returns the answer as an Anthropic message or SSE stream.

## Models

The model list is the upstream's own catalogue, fetched per account (`GET /api/v1/freebuff/models`). A model is addressed by its catalogue `key` (for example `m-61c26317cc`) or by the slug of its display name (`mimo-v2-6-flash-slow`); the row's signed `handle` is what the chat body selects upstream. Every open row is offered; a row the account cannot use answers as the upstream does, and any id outside the catalogue answers `invalid_request`. `claude-haiku-4-5`, the model `clauth proxy check` sends, resolves to the catalogue's default open row.

Each row carries its own `access`, `dataUse` and `premium` flags from the catalogue; a row whose `dataUse` is `training` trains on your data. The free tier keeps its quota server-side and exposes only the live session's remaining time, so nothing here reports it.

The free-mode chat is gated on the CLI's own system prompt, so every chat's first system message starts with this exact opening (the date is the live one):

```text
You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

Current date: October 27, 2026.
```

A client's own system prompt follows it; when the client sends none, the opening rides alone.

## How it works

| stage | what happens |
|---|---|
| login | the proxy runs the freebuff CLI's own login: a fingerprint-keyed code, the upstream login URL, and a status poll until the account's auth token arrives; a GET on the streak route validates it, with no side effect upstream |
| session | chats run sessionless like the CLI; the upstream binds its session to the model on the first chat, and the `session` figure reads `GET /api/v1/freebuff/session` |
| run | an agent run `START`s per chat and `FINISH`es once the answer is fully sent (on a stream, after the last byte) |
| chat | the converted body selects the catalogue row's `handle` and carries the CLI's `codebuff_metadata` (`run_id`, `client_id`, `trace_session_id`, `cost_mode: "free"`, `freebuff_instance_id` as the proxy's local `cli:` id, the multi-session and `surface: "cli"` markers, and the client-env fields) plus `provider.data_collection: "deny"` |
| retries | one retry per error class: a dead run id, a stale catalogue, a session bound to another model (its session ends once, then the chat retries) |
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

The login is the freebuff CLI's own browser flow, driven by the proxy, so nothing needs installing: start a flow, open the URL it returns, and sign in with GitHub. The proxy polls the upstream login status, completes once the account's auth token arrives, and mints the account's inference key:

```sh
PORT=$(clauth proxy list --json | jq -r '.[] | select(.service == "freebuff") | .port')
ADMIN=$(cat ~/.clauth/proxies/freebuff/clauth-admin-token)
LOGIN=$(curl -sS -X POST "http://127.0.0.1:$PORT/clauth/v1/accounts/login" -H "Authorization: Bearer $ADMIN")
FLOW=$(echo "$LOGIN" | jq -r .flow)
echo "$LOGIN" | jq -r .url      # open this URL in a browser, then sign in with GitHub
while :; do
  STATUS=$(curl -sS "http://127.0.0.1:$PORT/clauth/v1/accounts/login/$FLOW" -H "Authorization: Bearer $ADMIN")
  [ "$(echo "$STATUS" | jq -r .state)" = "pending" ] || break
  sleep 5
done
echo "$STATUS" | jq '{state, label: .account.label, inference_key}'
```

The done answer carries the account and its inference key. The key is shown once; the proxy stores only its hash. An existing auth token can be pasted into the same flow instead (`POST /clauth/v1/accounts/login/{flow}` with `{"code": "<auth-token>"}`), which validates it against the upstream streak route before completing. Point Claude Code at the proxy with the key:

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

## What it leaves out

- No freebuff CLI and no browser helper to install: the proxy speaks the login endpoints itself, and a pasted token still works.
- No ads, streak reporting, agent validation or WARP: the upstream requires none of them for chat.
- No quota of its own: the session figure reads the upstream session, and no other number is invented.
- No UI of its own: the proxy serves the contract and nothing else.

## Comparison

The two other freebuff implementations this proxy was measured against put a different face on the same upstream:

| | clauth-freebuff-proxy | free-buff-lol | Freebuff2API |
|---|---|---|---|
| client wire | Anthropic `/v1/messages`, converted both ways, streaming included | Anthropic face, but only non-streaming is converted; the stream is an openai SSE passed through | Anthropic, converted both ways |
| integration | a clauth proxy: enabled, supervised and read through clauth | a standalone server with a dashboard | a standalone server |
| ads, streaks, agent validation | only a side-effect-free streak probe at login | opportunistic calls, failures swallowed | never sent |

## FAQ

**How do I use freebuff's free models with Claude Code?** Put `clauth-freebuff-proxy` on `PATH`, run `clauth proxy enable freebuff`, log an account in through its browser login, and point Claude Code at the proxy's loopback port with the inference key.

**Does clauth-freebuff-proxy need the freebuff CLI installed?** No. The proxy speaks the CLI's wire itself; only the account's auth token is needed.

**Which models are free, and which draw on the session pool?** The catalogue's own flags decide: an `open` row without `premium` is the free tier, and a locked or premium row answers as the upstream does. The upstream keeps the daily one-hour session pool server-side.

**Can my freebuff account get banned?** freebuff's upstream says free mode is CLI-only and that direct API use may get accounts banned. The proxy sends the CLI's own wire; that is no guarantee.

## Development

```sh
bun run check             # tsc --noEmit && bun test
bun run check:conformance # drives `clauth proxy check` against a stub upstream, in safe and --destructive modes
bun run check:parity      # compares the proxy's upstream requests against the shapes pinned in scripts/parity-core.ts
```

The conformance run needs the `clauth` binary at `CLAUTH_BIN` or `~/.cargo/bin/clauth`.

## License

MIT OR Apache-2.0, at your choice: [LICENSE-MIT](LICENSE-MIT) or [LICENSE-APACHE](LICENSE-APACHE).
