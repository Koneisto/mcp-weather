# Security Policy

## Supported versions

Security fixes are made for the latest release.

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a vulnerability

Please do not open a public issue for security problems.

- Preferred: report privately through GitHub
  ([Security > Report a vulnerability](https://github.com/Koneisto/mcp-weather/security/advisories/new)).
- Or email **noreply@example.invalid**.

Include the affected version, how to reproduce the problem and its impact. You will get an acknowledgement within
7 days. Once a fix is released, the report is credited in the release notes unless you prefer otherwise.

## Scope

mcp-weather only reads public weather data and keeps no user data. Things worth reporting include, for example,
API keys leaking into output or logs, ways to make the server request arbitrary URLs, and input that crashes or stalls
the HTTP transport. The HTTP transport has no authentication of its own; run it on a trusted network or behind a proxy
that adds authentication.
