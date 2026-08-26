#!/usr/bin/env node

import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { platform } from 'node:process'
import { createInterface } from 'node:readline'

const SERVER_NAME = 'flowix'
const TOOL_NAME = 'memo'
const INSTALL_URL = 'https://flowix-memo.com/latest.json'
const TOOL_SCHEMA = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'memo-tool-schema.json'), 'utf8'))

const cli = findCli()
if (cli !== undefined) {
  proxyToCli(cli)
} else {
  runUnavailableServer()
}

function findCli() {
  const explicit = [process.env.FLOWIX_DSH_MCP_CLI, process.env.FLOWIX_CLI_PATH]
    .find(value => typeof value === 'string' && value.trim() !== '')
  if (explicit !== undefined) return isExecutable(explicit.trim()) ? explicit.trim() : undefined

  const candidates = []
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Flowix.app/Contents/MacOS/flowix-cli',
      join(process.env.HOME ?? '', 'Applications/Flowix.app/Contents/MacOS/flowix-cli'),
    )
  }
  if (platform === 'win32') {
    const appData = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env.ProgramFiles ?? ''
    candidates.push(
      join(appData, 'Flowix', 'flowix-cli.exe'),
      join(programFiles, 'Flowix', 'flowix-cli.exe'),
    )
  }
  candidates.push('flowix-cli', 'flowix')
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

function resolveCommand(command) {
  if (command.includes('/') || command.includes('\\')) {
    return isExecutable(command) ? command : undefined
  }
  const pathValue = process.env.PATH ?? ''
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const directory of pathValue.split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, command + suffix)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

function isExecutable(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function proxyToCli(command) {
  let child
  try {
    child = spawn(command, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  } catch (error) {
    process.stderr.write(`[${SERVER_NAME}] failed to start Flowix CLI: ${String(error)}\n`)
    runUnavailableServer()
    return
  }
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  child.once('error', error => {
    process.stderr.write(`[${SERVER_NAME}] failed to start Flowix CLI: ${String(error)}\n`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}

function runUnavailableServer() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      writeResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (message.id === undefined) return
    if (message.method === 'initialize') {
      writeResponse({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        },
      })
      return
    }
    if (message.method === 'ping') {
      writeResponse({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }
    if (message.method === 'tools/list') {
      writeResponse({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{
            name: TOOL_NAME,
            description: 'Search and edit Flowix memos. Requires the Flowix CLI.',
            inputSchema: TOOL_SCHEMA,
          }],
        },
      })
      return
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name
      const text = name === TOOL_NAME
        ? `Flowix CLI is unavailable. Install Flowix from ${INSTALL_URL} for your platform, or set FLOWIX_CLI_PATH to the absolute path of flowix-cli. After installation, restart the DSH profile and retry this tool.`
        : `Unknown tool: ${String(name)}`
      writeResponse({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text }] },
      })
      return
    }
    writeResponse({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${String(message.method)}` },
    })
  })
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}
