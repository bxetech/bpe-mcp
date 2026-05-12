# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in this MCP
server, **please do not open a public GitHub issue.** Instead, report it
privately so we can investigate and ship a fix before details become
public.

**Preferred channel:** GitHub Security Advisory — open a draft advisory
on this repository under the *Security* tab → *Advisories* → *Report a
vulnerability*. This routes the report directly to the maintainers and
is invisible to anyone else until we publish.

**Alternative:** email <security@bxetech.com> with a description of the
issue and steps to reproduce. PGP encryption available on request.

## Scope

In scope:

- This npm package (`@bxetech/bpe-mcp`) and its installation flow.
- The protocol-level interaction between the MCP server and any
  upstream BPE API endpoints it calls on behalf of the user.
- API-key handling on the local machine where the MCP server runs.

Out of scope (handled separately):

- The BPE API itself (`api.bxetech.com`) — report at
  <security@bxetech.com> with subject prefix `[BPE API]`.
- The BXETECH website (`bxetech.com`) — same address, prefix
  `[BXETECH website]`.
- Issues affecting Anthropic's Claude Desktop, Cursor, or other MCP
  clients themselves — report to those vendors directly.

## What we ask

- Provide enough detail for us to reproduce the issue.
- Don't exploit the vulnerability beyond what is needed to demonstrate
  it.
- Don't access, modify, or delete data belonging to other BPE API
  customers.
- Give us reasonable time to fix the issue before public disclosure
  (typically 90 days, faster for critical issues).

## What you can expect

- Acknowledgement within 3 business days.
- A status update within 10 business days, including whether the issue
  is accepted, deferred, or out of scope.
- Credit in the release notes when a fix ships, unless you'd prefer to
  remain anonymous.

## Known limitations

The v0.1 release does not currently:

- Validate webhook subscription URLs against SSRF (the
  `subscribe_alert` tool ships in v0.2; SSRF protections will land at
  the same time).
- Encrypt API keys at rest within MCP client config files (this is a
  property of the host MCP client, e.g. Claude Desktop, not of this
  package).

These are tracked publicly in the issue tracker and in the
[`AGENT_INTEGRATION_AND_MONETISATION_2026-04-27.md`](https://bxetech.com/agents)
research note.
