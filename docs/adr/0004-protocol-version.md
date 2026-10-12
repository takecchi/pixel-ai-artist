# ADR-0004 — Target MCP 2025-11-25, design forward to 2026-07-28

**Status:** accepted · 2026-09-08

## Context

The current MCP specification is **2026-07-28**. It is a large revision: the
protocol core became stateless (no `initialize` handshake, no `Mcp-Session-Id`),
server-initiated requests were replaced by Multi Round-Trip Requests, list
responses gained cache hints, and Tasks and MCP Apps became formal extensions.

The published TypeScript SDK (`@modelcontextprotocol/sdk@1.30.0`, the current
`latest` at the time of writing) advertises `2025-11-25` as its latest protocol
version. The 2026-07-28 support is not in a released package on npm.

Shipping against a spec the SDK cannot speak would mean hand-rolling a transport
and losing every client that negotiates through the SDK — which is all of them.

## Decision

Speak what the SDK speaks: **2025-11-25**. Design so the move to 2026-07-28 is a
dependency bump rather than a rewrite:

- **No server-side session state.** Nothing on the server survives between tool
  calls that the caller could not pass back as an argument. The sprite target is
  named in every call; there is no "current sprite" held in the server.
- **`outputSchema` and `structuredContent` on every tool.** Results are typed
  data, not text the model re-parses. *(Amended in the port: on success only.
  An error result carries no structured content, because clients validate it
  against the success schema; its code leads the text instead.)*
- **No reliance on server→client requests.** No sampling, no roots, no
  elicitation. Confirmation that needs a human — closing an unsaved sprite — is
  handled by refusing with an explanation and requiring an explicit flag on the
  retry. (aseprite-ai-artist also gated lossy rotation this way; nothing behind
  the flag ever succeeded, so the port refuses those angles outright.) That pattern is exactly what MRTR formalises, so
  it converts cleanly.
- **Immutable tool list.** `tools/list` does not vary per connection, which is
  what 2026-07-28 requires and what makes the list cacheable.
- **Deprecated features avoided** even though they still work.

## Consequences

**Good.** Works today in every client, and the eventual upgrade is a version
bump plus adopting cache hints.

**Good.** The stateless discipline is better design regardless of the spec: a
call that names its sprite (`'#7'`) means the same thing whatever was active
before it.

**Bad.** No Tasks extension, so a long spritesheet export blocks its tool call
rather than returning a handle. Acceptable at the sizes involved; worth
revisiting when Tasks lands in the SDK.

## Revisit when

`@modelcontextprotocol/sdk` publishes a release whose `LATEST_PROTOCOL_VERSION`
is `2026-07-28`.
