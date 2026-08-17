# dsh-flowix-memory

A config-only [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle that registers the **local `flowix-cli` MCP server** with any Harness
instance. Once installed, the agent gets the
`mcp__dsh-flowix-memory__flowix_memo` tool to search, read, create, and edit
Flowix Markdown memos, and to create declared plugin artifacts such as mind
maps.

The bundle contains **no code**: it is a `cordis.patch.yml` that inserts one
[`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/mcp/mcp-client)
row, which ships inside every Harness distribution. Nothing here connects to a
remote Flowix service — the CLI is spawned locally over stdio and reads the
local notebook data directory.

## Prerequisites

1. A `flowix` CLI executable on `PATH` (or set `FLOWIX_CLI_PATH` to its
   absolute path). The CLI is built from the
   [flowix-main](https://github.com/text2future/flowix) repository
   (`app/flowix-cli`, binary `flowix-cli`).
2. Access to the Flowix notebook data the CLI should manage. Defaults to the
   user config directory (`~/.flowix`); override with `FLOWIX_HOME` /
   `FLOWIX_DATA` when the data lives elsewhere.

## Install

```sh
# published package
dsh plugin add dsh-flowix-memory

# or local checkout / tarball
dsh plugin add ./dsh-flowix-memory
dsh plugin add ./dsh-flowix-memory-0.1.0.tgz
```

The row activates for the current profile. To persist across profiles, add the
package to each profile's `cordis.patch.yml`, or see
`dsh plugin --help` for profile selection.

## Verify

Start Harness (`dsh web`), then check that the tool is registered:

```
mcp__dsh-flowix-memory__flowix_memo
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `FLOWIX_CLI_PATH` | `flowix` (PATH lookup) | Absolute path to the flowix-cli executable |

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-flowix-memory
```

## Notes

- The MCP stdio bridge strips ambient credential-like variables and all
  `DSH_*` variables before spawning the child; other ambient variables
  (including `HOME`/`PATH`) are inherited.
- This bundle mirrors the `dsh-flowix-memory` row embedded in Flowix Desktop's
  own Harness composition (`config/flowix.cordis.yml`). The embedded row
  resolves the CLI path through `FLOWIX_DSH_MCP_CLI` (host-injected); the
  external bundle uses `FLOWIX_CLI_PATH ?? 'flowix'`. Keep them in sync —
  `tests/bundle-sync.test.ts` guards the drift.
