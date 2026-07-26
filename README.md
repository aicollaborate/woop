<p align="center">
  <img src="./docs/images/app-icon.png" width="120" alt="Flowix Memo" />
</p>

<h2 align="center">Flowix Memo</h2>

<p align="center">
  <a href="https://github.com/text2future/flowix/releases"><img src="https://img.shields.io/badge/Platform-macOS%20|%20Windows-0078D4" alt="Supported platforms" /></a>
  <a href="https://github.com/text2future/flowix/releases"><img src="https://img.shields.io/github/v/release/text2future/flowix" alt="Latest release" /></a>
</p>

![Flowix Memo](./docs/images/readme-banner.png)

**Flowix Memo is a local document workspace built for AI Agents.**

It brings everyday notes, task requirements, reference materials, agent conversations and outputs together into a single Markdown workflow, so context can accumulate over time and be continuously edited and reused.

Flowix Memo mainly helps solve these common problems:

- Prompts and task instructions scattered everywhere, hard to manage
- Agents lacking stable context, repeatedly making the same mistakes
- Workflows and valuable outputs from conversations that are hard to capture and reuse

In Flowix Memo, a document can serve as a note, but also as an agent's task instructions, long-term memory and work results. AI collaboration no longer ends at a one-off chat; it gradually accumulates into knowledge you can review, edit and call upon again.

## What you can do with it

### Capture everyday notes and consolidate agent work

Keep reading notes, travel plans, work logs and everyday writing, or write requirements, materials and reference links into a document so an agent can summarize, rewrite, answer questions, break down tasks or write code based on clear context.

An agent's output can be written back into the document, becoming the input for the next round of work.

### Organize project context with notebooks

A notebook is simply a local folder. You can keep work, research, client projects, journals, reference libraries or code projects in separate notebooks.

Switching notebooks also switches your default working context. This reduces information noise between projects and makes it easier to give an agent only the materials it needs to finish the task.

### Keep your content local for the long term

Notes are saved as plain Markdown files on your disk. You can open them directly in other editors, or hand them to your own sync drive, backup tool or version control system.

Your content is never locked into a proprietary cloud service. Even if you switch tools later, your documents stay readable, portable and usable.

### Call different agents from within a document

Flowix Memo supports a built-in AI Agent and can also connect to local CLI agents such as Claude Code, Codex and Hermes. For each task you control what an agent can see — for example the current note, a specific folder, an entire notebook or a project directory.

The clearer the context, the more stable an agent's output. Once the process is recorded, it's also easier to review, revise and keep moving forward.

The built-in agent uses a BYOK (Bring Your Own Key) model. Only when you actively send a model request is the selected context sent to the model provider you configured.

### Connect to external agent workflows

The Flowix CLI lets local agents perform non-interactive note operations;
MCP lets external agent clients that support MCP read, search and update Flowix documents.

For external agent clients, MCP is the recommended option. See the [help docs](https://flowix-memo.com/docs/) for configuration and tool details.

## Core capabilities

**Markdown and local folders**: data is directly accessible, backup-friendly, portable and version-controllable<br>
**Tags and properties**: structure information with inline tags and YAML frontmatter<br>
**BYOK and multiple providers**: supports model services such as OpenAI, Anthropic and DeepSeek<br>
**Built-in and local agents**: use the built-in agent, Claude Code, Codex or Hermes within a document<br>
**CLI and MCP**: connect documents to local or external agent workflows<br>
**Multi-window and multi-tab**: split notes into child windows and move tabs between windows

![AI Agent](./docs/images/readme-agent.png)

## Quick start

1. Download and install Flowix Memo from [Releases](https://github.com/text2future/flowix/releases).
2. Create a new local folder, or register an existing folder as a notebook.
3. Create a document and write down the task background, reference materials, goals and constraints.
4. Call an agent from within the document, or keep organizing content with tags and properties.

## Local development

```bash
git clone https://github.com/text2future/flowix.git
cd flowix
npm install

npm run tauri dev
npm run dev
npm run tauri build
```

The development environment requires Node.js 20+, Rust 1.75+ and Tauri v2; the desktop app supports macOS 14+ and Windows 10+.

## More information

Issues and Pull Requests are welcome.

- Website: [https://flowix-memo.com/](https://flowix-memo.com/)
- Help docs: [https://flowix-memo.com/docs/](https://flowix-memo.com/docs/)
- GitHub: [https://github.com/text2future/flowix](https://github.com/text2future/flowix)
