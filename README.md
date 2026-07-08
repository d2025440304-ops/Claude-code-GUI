# Claude Code GUI

A lightweight, native-feeling desktop GUI for the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI — macOS only.

Built with **Electron + React + TypeScript + SQLite + Tailwind CSS**, Claude Code GUI wraps the `claude` command-line tool into a polished multi-window chat experience with full conversation persistence, streaming responses, file/image attachments, and more.

> ⚠️ This project is an independent, community-built client and is **not** affiliated with or endorsed by Anthropic. It requires a working installation of the official `claude` CLI.

## Features

- **Multi-window conversations** — Open each conversation in its own window, or keep them all in the sidebar. Cross-window sync keeps everything in lockstep.
- **Streaming responses** — Assistant replies stream in real time via `--output-format stream-json`.
- **SQLite persistence** — Every conversation and message is stored locally with WAL mode, so nothing is lost on crash or restart.
- **Crash-safe streaming** — Assistant text is flushed to the database incrementally (throttled), so a mid-stream crash preserves the partial response.
- **Session resume** — Captures the Claude CLI session id and uses `--resume` to continue a conversation thread.
- **Model selector** — Switch models per conversation.
- **Project context** — Bind a conversation to a project folder (`cwd`), grouped in the sidebar tree.
- **File & image attachments** — Attach files (referenced as `@path`) and images (sent as base64 content blocks). macOS Finder clipboard paste is supported.
- **Pin / rename / delete** — Full conversation management with a context menu.
- **Dark & light themes** — Follows the system theme by default, with manual override.
- **Keyboard shortcuts** — `⌘N` new chat · `⌘B` toggle sidebar · `⌘K` search · `Esc` stop generation.
- **Secure by default** — `contextIsolation: true`, `nodeIntegration: false`, with a hardened preload bridge.

## Prerequisites

1. **macOS** (the app uses macOS-specific window styling and clipboard features).
2. **Node.js** ≥ 18 and npm.
3. **Claude Code CLI** installed and available on your `PATH`:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
   Verify with `claude --version`.

## Getting Started

```bash
# clone
git clone git@github.com:d2025440304-ops/Claude-code-GUI.git
cd Claude-code-GUI

# install dependencies
npm install

# run in development (Vite + tsc --watch + Electron)
npm run dev

# build for production
npm run build

# launch the built app
npm start
```

The dev server runs on `http://127.0.0.1:5174` and hot-reloads the renderer. The Electron main process recompiles on TypeScript changes.

## Architecture

```
claude-code-desktop/
├── electron/               # Main process (Node.js / Electron)
│   ├── main.ts             # App bootstrap, IPC handlers, lifecycle
│   ├── preload.ts          # Context-isolated IPC bridge
│   ├── ipc/channels.ts     # Typed IPC channel names
│   ├── integration/
│   │   ├── cli-detector.ts # Detects `claude` on PATH
│   │   ├── cli-spawner.ts   # Spawns & manages Claude CLI subprocesses
│   │   └── stream-parser.ts# Parses stream-json output into chunks
│   └── db/
│       ├── database.ts                 # SQLite wrapper (WAL, migrations)
│       ├── migrations/001-init.sql     # Schema
│       └── repositories/               # Conversation & message repos
├── src/                    # Renderer process (React)
│   ├── App.tsx             # Sidebar, project tree, routing
│   ├── components/         # ChatView, ConversationItem, ModelSelector, …
│   ├── lib/ipc.ts          # Renderer-side IPC helpers
│   └── types.ts            # Shared types & model list
├── index.html
└── vite.config.ts
```

### How it works

1. The renderer sends a message via the typed IPC bridge (`preload.ts`).
2. The main process persists the user message, then spawns a one-shot
   `claude -p "<msg>" --output-format stream-json --verbose --include-partial-messages [--resume <id>]`
   subprocess in the conversation's project folder.
3. A `StreamParser` incrementally parses the NDJSON stdout into typed chunks
   (`text`, `meta`, `tool`, `error`).
4. Chunks are routed only to the window(s) bound to that conversation, and the
   accumulated assistant text is flushed to SQLite on a 400 ms throttle so a
   crash never loses the partial reply.
5. On stream close, the conversation preview is updated and all sidebars are
   refreshed across windows.

## Tech Stack

| Layer        | Technology                                   |
| ------------ | -------------------------------------------- |
| Shell        | Electron 31                                   |
| UI           | React 18 + TypeScript 5                       |
| Styling      | Tailwind CSS 3 + CSS variables (theming)      |
| State        | Zustand / React hooks                         |
| Storage      | better-sqlite3 (WAL mode, migrations)         |
| Build        | Vite 5 (renderer) + tsc (main)               |
| Integration  | Claude Code CLI (`stream-json` protocol)      |

## Project Roadmap

- Cross-platform support (Windows / Linux)
- Slash-command palette
- Conversation search (full-text)
- Export conversations (Markdown / JSON)
- Configurable CLI flags & system prompts

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change, then submit a pull request.

1. Fork the repo and create your branch: `git checkout -b feat/my-feature`
2. Commit with clear messages
3. Open a Pull Request against `main`

## License

[MIT](./LICENSE) © Yu-dai
