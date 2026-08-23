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

1. A `flowix` command on `PATH` (or set `FLOWIX_CLI_PATH` to the absolute
   `flowix-cli` binary path). The CLI is built from the
   [flowix-main](https://github.com/text2future/flowix) repository
   (`app/flowix-cli`, binary `flowix-cli`).
2. Access to the Flowix notebook data the CLI should manage. Defaults to the
   user config directory (`~/.flowix`); override with `FLOWIX_HOME` /
   `FLOWIX_DATA` when the data lives elsewhere.

## Install

`dsh plugin` manages one profile at a time and requires `--profile <name>`
(shipped profiles: `web`, `headless`). The bundle remains independent from
Flowix's host/control bridge and ships in the
[flowix-main](https://github.com/text2future/flowix) repository and is not yet
published to npm, so install it from the checkout:

```sh
# from the flowix-main checkout root
dsh plugin --profile <name> add ./flowix-dsh-host/bundles/dsh-flowix-memory
```

Once published, the npm package installs the same way:

```sh
dsh plugin --profile <name> add dsh-flowix-memory
```

The row activates for that profile. To persist across profiles, install the
package into each profile, or see `dsh plugin --help` for profile selection.

## Verify

Start Harness for the profile you installed into (`dsh web` for the `web`
profile), then check that the tool is registered:

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
- Flowix Desktop installs this same bundle into its `flowix` profile and sets
  `FLOWIX_DSH_MCP_CLI`. Other DSH clients can install it into any profile and
  use `FLOWIX_CLI_PATH` or the `flowix` executable on PATH. There is one
  canonical bundle patch and no embedded duplicate row.
