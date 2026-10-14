# Contributing

Bug reports, fixes and new data sources are welcome. For larger changes, please open an issue first so the approach can
be agreed on before you spend time on it.

## Development setup

Requires Node.js 22 or later.

```bash
git clone https://github.com/Koneisto/mcp-weather.git
cd mcp-weather
npm ci
npm run build
npm test
```

`npm test` runs offline: external sources answer from recorded responses in `test/fixtures`, and the MCP tests use a
real MCP client in memory and over HTTP on a local port. The live acceptance test talks to the real sources and uses
their quota, so run it only when you change how a source is queried:

```bash
npm run test:live -- "node build/index.js"
```

## Pull requests

- Keep each pull request focused on one change, and add or update tests for behaviour changes.
- `npm run build` and `npm test` must pass; CI runs them on all supported Node.js versions.
- TypeScript in strict mode, ES modules, no new runtime dependencies without a good reason.
- Never commit API keys or `.env` files. Optional keys are read from the environment only.
- Tool output stays the same for every client: readable text plus `structuredContent` that matches the tool's
  `outputSchema`. If you change the data a tool returns, update its schema.
- New sources must be free to use or optional, name themselves in the output, and respect the provider's licence and
  terms of use.
- Write commit messages in the imperative mood ("Add ...", "Fix ...") and add a line under `Unreleased` in
  `CHANGELOG.md` for user-visible changes.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
