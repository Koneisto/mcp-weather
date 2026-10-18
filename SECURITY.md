# Security Policy

## Supported versions

Security fixes are made for the latest release.

| Version | Supported |
|---------|-----------|
| 1.6.x   | Yes       |

## Reporting a vulnerability

Please do not open a public issue for security problems.

- Preferred: report privately through GitHub
  ([Security > Report a vulnerability](https://github.com/Koneisto/mcp-weather/security/advisories/new)).
- Or email **noreply@example.invalid**.

Include the affected version, how to reproduce the problem and its impact. You will get an acknowledgement within
7 days. Once a fix is released, the report is credited in the release notes unless you prefer otherwise.

## Scope

mcp-weather reads public weather data. Its private state may retain resolved place queries, public station/model data,
provider host names, hashed account partitions and request counters; it never intentionally stores API credentials. Things worth reporting include, for example,
API keys leaking into output or logs, ways to make the server request arbitrary URLs, and input that crashes or stalls
the HTTP transport. The HTTP transport has no authentication of its own. Local HTTP and the example Compose published port bind to
loopback by default; Docker listens on its own container interface. Use a trusted network or a proxy that adds
authentication. Origin checks supplement these boundaries and are not authentication. Inbound body size/deadline,
MCP concurrency, upstream queue/concurrency/body size and full-response deadlines limit resource use.


The compact endpoint uses the same transport protections and backend as the full endpoint. Both endpoints need
an authenticated proxy outside a trusted network. Per-provider budgets protect upstream quotas, not access control.
Keep MCP_STATE_DIR private and writable by the service user (directory0700, files0600), backed by persistent storage.
A crash-left quota.lock or corrupt quota.json blocks new upstream calls. Inspect state and confirm no transaction is
active before removing only the stale lock; do not delete quota.json to reset spent allowance. Never mount this state
into untrusted containers. Independent state volumes do not coordinate account usage across hosts.
