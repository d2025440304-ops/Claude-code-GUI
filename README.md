# Claude Code GUI

一个轻量、原生体验的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 桌面图形界面 —— 仅支持 macOS。

基于 **Electron + React + TypeScript + SQLite + Tailwind CSS** 构建，Claude Code GUI 将 `claude` 命令行工具封装为一个精致的多窗口对话体验，具备完整的会话持久化、流式响应、文件/图片附件等功能。

> ⚠️ 本项目是社区独立开发的客户端，**不**隶属于 Anthropic，也未经其认可。使用前需先安装官方 `claude` CLI。

## 功能特性

- **多窗口会话** —— 每个会话可在独立窗口打开，也可全部收纳在侧边栏。跨窗口同步确保数据始终一致。
- **流式响应** —— 助手回复通过 `--output-format stream-json` 实时流式呈现。
- **SQLite 持久化** —— 所有会话和消息以 WAL 模式存储在本地，崩溃或重启也不会丢失。
- **崩溃安全流式** —— 助手文本以节流方式增量写入数据库，即使流式中途崩溃也能保留部分回复。
- **会话续接** —— 自动捕获 Claude CLI 的 session id，使用 `--resume` 延续对话线程。
- **模型选择** —— 可为每个会话单独切换模型。
- **项目上下文** —— 将会话绑定到项目文件夹（`cwd`），在侧边栏树状分组展示。
- **文件与图片附件** —— 支持附加文件（以 `@path` 引用）和图片（以 base64 内容块发送）。支持 macOS Finder 剪贴板粘贴。
- **置顶 / 重命名 / 删除** —— 通过右键菜单完整管理会话。
- **深色与浅色主题** —— 默认跟随系统主题，可手动切换。
- **快捷键** —— `⌘N` 新建会话 · `⌘B` 切换侧边栏 · `⌘K` 搜索 · `Esc` 停止生成。
- **安全默认** —— `contextIsolation: true`、`nodeIntegration: false`，配合加固的 preload 桥接层。

## 前置条件

1. **macOS**（应用使用了 macOS 专属的窗口样式与剪贴板特性）。
2. **Node.js** ≥ 18 及 npm。
3. 已安装并在 `PATH` 中可用的 **Claude Code CLI**：
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
   使用 `claude --version` 验证安装。

## 快速开始

```bash
# 克隆仓库
git clone git@github.com:d2025440304-ops/Claude-code-GUI.git
cd Claude-code-GUI

# 安装依赖
npm install

# 开发模式运行（Vite + tsc --watch + Electron）
npm run dev

# 生产构建
npm run build

# 启动构建后的应用
npm start
```

开发服务器运行在 `http://127.0.0.1:5174`，渲染进程支持热重载。Electron 主进程在 TypeScript 变更时自动重新编译。

## 架构

```
claude-code-desktop/
├── electron/               # 主进程（Node.js / Electron）
│   ├── main.ts             # 应用引导、IPC 处理、生命周期
│   ├── preload.ts          # 上下文隔离的 IPC 桥接
│   ├── ipc/channels.ts     # 类型化的 IPC 通道名
│   ├── integration/
│   │   ├── cli-detector.ts # 检测 PATH 中的 `claude`
│   │   ├── cli-spawner.ts  # 生成并管理 Claude CLI 子进程
│   │   └── stream-parser.ts# 将 stream-json 输出解析为分块
│   └── db/
│       ├── database.ts             # SQLite 封装（WAL、迁移）
│       ├── migrations/001-init.sql # 数据库 schema
│       └── repositories/           # 会话与消息仓库
├── src/                    # 渲染进程（React）
│   ├── App.tsx             # 侧边栏、项目树、路由
│   ├── components/         # ChatView、ConversationItem、ModelSelector 等
│   ├── lib/ipc.ts          # 渲染进程侧 IPC 辅助
│   └── types.ts            # 共享类型与模型列表
├── index.html
└── vite.config.ts
```

### 工作原理

1. 渲染进程通过类型化的 IPC 桥接（`preload.ts`）发送消息。
2. 主进程持久化用户消息后，在会话所属的项目文件夹中生成一次性子进程：
   `claude -p "<msg>" --output-format stream-json --verbose --include-partial-messages [--resume <id>]`
3. `StreamParser` 增量地将 NDJSON stdout 解析为类型化分块（`text`、`meta`、`tool`、`error`）。
4. 分块仅路由到绑定该会话的窗口；累积的助手文本以 400ms 节流写入 SQLite，确保崩溃不丢失部分回复。
5. 流结束时更新会话预览，并跨窗口刷新所有侧边栏。

## 技术栈

| 层级     | 技术                                          |
| -------- | --------------------------------------------- |
| 外壳     | Electron 31                                   |
| 界面     | React 18 + TypeScript 5                       |
| 样式     | Tailwind CSS 3 + CSS 变量（主题化）           |
| 状态     | Zustand / React hooks                         |
| 存储     | better-sqlite3（WAL 模式、迁移）              |
| 构建     | Vite 5（渲染进程）+ tsc（主进程）             |
| 集成     | Claude Code CLI（`stream-json` 协议）         |

## 路线图

- 跨平台支持（Windows / Linux）
- 斜杠命令面板
- 会话全文搜索
- 导出会话（Markdown / JSON）
- 可配置的 CLI 参数与系统提示词

## 贡献

欢迎贡献！请先开一个 issue 讨论你想做的改动，然后提交 Pull Request。

1. Fork 仓库并创建分支：`git checkout -b feat/my-feature`
2. 使用清晰的提交信息
3. 向 `main` 分支发起 Pull Request

## 许可证

[MIT](./LICENSE) © Yu-dai
