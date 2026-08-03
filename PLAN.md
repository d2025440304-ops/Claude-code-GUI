# Claude Code Desktop — 审计与优化计划书

> 项目路径：`/Users/dai/Documents/Playground/claude-code-desktop`
> 审计日期：2026-07-25
> 技术栈：Electron 31 + React 18 + Vite 5 + Zustand + better-sqlite3 + xterm.js

---

## 一、项目架构概览

本应用是一个 macOS 桌面端 Claude Code GUI 客户端，提供两种交互模式：

- **Agent 模式**：通过 `@anthropic-ai/claude-agent-sdk` 直接调用 SDK，支持多轮会话、工具调用可视化、权限审批流。
- **Chat 模式**：通过子进程启动 Claude CLI（`--output-format stream-json`），解析 NDJSON 流式输出。

两种模式共享同一个 SQLite 数据库（conversations + messages），通过 Electron IPC 通信，前端使用 React + Zustand 管理状态。

---

## 二、Bug 审计报告

### 2.1 Agent 模式 — 高严重度

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| A1 | **Cmd+Enter 双重发送** | `AgentChatInput.tsx:291-292` | 按下 Cmd+Enter 时两个 `if` 条件同时满足，`handleSend()` 被调用两次，消息重复发送 |
| A2 | **Session ID 提前写入** | `agent-sdk-bridge.ts:175-177` | SDK 尚未确认即持久化 sessionId；若首次 query 失败，后续 resume 一个从未创建的 session 导致报错 |
| A3 | **SDK 加载失败永久缓存** | `agent-sdk-bridge.ts:39-50` | `sdkLoadError` 为模块级变量，一旦加载失败永远抛出，用户必须重启应用才能恢复 |
| A4 | **多权限请求仅返回第一个** | `agent-sdk-bridge.ts:673-678` | `getPendingPermission` 只返回队列首个，其余权限无 UI 处理，agent 永久挂起 |

### 2.2 Agent 模式 — 中严重度

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| A5 | 快速连发无本地锁 | `AgentConversationView.tsx:483-505` | status 异步更新，invoke 与 status 事件之间存在重发窗口 |
| A6 | `handleAgentEvent` 闭包过期 | `AgentConversationView.tsx:268-281` | useEffect 依赖不含 `onSessionIdChange`，父组件重渲染后回调失效 |
| A7 | AbortSignal 监听器泄漏 | `agent-sdk-bridge.ts:592-595` | 权限正常 resolve 后 abort listener 不移除，长会话累积 |
| A8 | status 从不设为 `completed` | `agent-sdk-bridge.ts` | 类型定义了 `completed` 但后端永远设 `idle`，相关 UI 逻辑为死代码 |
| A9 | `result` 消息过早设 idle | `agent-sdk-bridge.ts:520` | generator 仍在迭代，renderer 已启用输入框，存在竞态 |
| A10 | 事件监听注册晚于初始化 | `AgentConversationView.tsx:268-278` | `AGENT_CREATE` resolve 到 effect 重跑之间的事件丢失 |
| A11 | `file:search` 使用错误全局对象 | `AgentChatInput.tsx:111` | 使用 `(window as any).ipc` 而非 `window.claudeAPI`，@file 搜索可能完全失效 |
| A12 | 权限栏不自动滚动到视口 | `AgentConversationView.tsx:671-677` | 用户滚动查看历史时，权限请求出现在屏幕外，agent 看似卡死 |
| A13 | Branch 传入 block.id 而非 message ID | `AgentConversationView.tsx:553-565` | 分支功能使用客户端生成的 ID，后端期望数据库 ID，分支静默失败 |
| A14 | Abort 不发射 `aborted` 状态 | `agent-sdk-bridge.ts:650` | 设为 `idle` 而非 `aborted`，UI 无法区分自然完成与用户中止 |

### 2.3 Agent 模式 — 低严重度

| # | 问题 | 位置 |
|---|------|------|
| A15 | `toolUseMeta` Map 无限增长 | `agent-sdk-bridge.ts:88` |
| A16 | `changedFiles` 数组无限增长 | `agent-sdk-bridge.ts:85` |
| A17 | Block ID 用 `Date.now()` 可能碰撞 | `AgentConversationView.tsx` 多处 |
| A18 | IntersectionObserver 流式期间频繁重建 | `AgentConversationView.tsx:160-172` |
| A19 | 拖拽 resize 组件卸载时 listener 泄漏 | `AgentChatInput.tsx:133-155` |
| A20 | Agent IPC 通道无类型约束 | `contracts.ts` |
| A21 | `thinking_delta`/`text_delta` 只追加到末尾 block，中间插入其他类型会碎片化 | `AgentConversationView.tsx:323-383` |

### 2.4 Chat 模式 — 高严重度

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| C1 | **`stream:end` 重载 DB 擦除富内容** | `App.tsx:519-523` | 完成后从 DB 重载消息，但 DB 只存纯文本 → thinking/tool/diff 全部丢失；纯工具回复（无 text）直接消失 |
| C2 | **Chat 模式 contentBlocks 从不持久化** | `main.ts:396-401` | 只累积 `text` 类型 chunk 写入 DB，thinking/tool_use/tool_result/diff 重启后全部丢失 |
| C3 | **ERROR 状态无恢复路径** | `streamMachine.ts:24-38` | ERROR 只允许 RESET/SEND，正常 `stream:end` 的 STOPPED 被忽略，状态机永久卡死 |
| C4 | **INTERRUPTING 可永久锁死输入框** | `streamMachine.ts` + `cli-spawner.ts:300-303` | 若 spawner 提前返回不发射 close/error，STOPPED 永远不触发，输入框永久禁用 |
| C5 | **stdin EPIPE 未处理可崩溃主进程** | `cli-spawner.ts:200-204` | 子进程提前退出时 stdin 异步抛出 error 事件，无监听器 → 主进程崩溃 |

### 2.5 Chat 模式 — 中严重度

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| C6 | `hasReceivedOutput` 不识别 tool_use | `cli-spawner.ts:227-233` | 纯工具回合被误判为"无输出"，非零退出时报误导性错误 |
| C7 | 发送失败后孤儿用户消息 | `main.ts:684` | 用户消息先于 spawn 持久化，失败后 DB 留下无回复的孤儿记录 |
| C8 | `text-replace` 重放导致文本重复 | `main.ts:819-843` | 第二窗口 bind 时 content 与 contentBlocks 同时渲染 → 文字翻倍 |
| C9 | 流内 error 在 exit 0 时被吞 | `cli-spawner.ts:287` | CLI 报告错误但正常退出时不发射 stream:error |
| C10 | 中断后 tool_use block 永久 streaming | `App.tsx:63-77` | 无 content_block_stop 时 block 状态不终结，UI 显示永久转圈 |
| C11 | THINKING 状态可卡死 | `App.tsx:470` | FIRST_CHUNK 只在 state===THINKING 时 dispatch，竞态下错过转换 |

### 2.6 Chat 模式 — 低严重度

| # | 问题 | 位置 |
|---|------|------|
| C12 | 时间戳格式不一致（toLocaleTimeString vs ISO） | `App.tsx:746,818` |
| C13 | 畸形 NDJSON 行静默丢弃无日志 | `stream-parser.ts:90-96` |
| C14 | `parseAssembledAssistant` 只发射第一个 tool_use | `stream-parser.ts:224-238` |
| C15 | result 事件有 denial 时丢失 usage/cost | `stream-parser.ts:292-316` |
| C16 | 权限拒绝气泡重复渲染 | `App.tsx:98-108` |
| C17 | 用户主动 stop 显示为 Error 消息 | `cli-spawner.ts:316-326` |

---

## 三、Agent 输入框功能补齐方案

### 3.1 当前差异总结

| 功能 | Chat 模式 | Agent 模式 | 优先级 |
|------|-----------|------------|--------|
| 图片粘贴 (Clipboard → base64) | ✅ | ❌ | P0 |
| 图片/文件拖放 (Drag & Drop) | ✅ | ❌ | P0 |
| 文件选择对话框 (Paperclip 按钮) | ✅ | ❌ | P0 |
| 图片选择对话框 (Image 按钮) | ✅ | ❌ | P0 |
| 附件预览条 (缩略图 + 删除) | ✅ | ❌ | P0 |
| 拖放视觉反馈 (边框高亮) | ✅ | ❌ | P1 |
| StreamActivityBar (上下文活动提示) | ✅ | ❌ | P1 |
| 快捷操作 Chips (空状态引导) | ✅ | ❌ | P2 |
| `/run` 命令 | ✅ | ❌ | P2 |
| @file 引用搜索 | ❌ | ✅ | — |
| 拖拽调整输入框高度 | ❌ | ✅ | — |
| /help 本地覆盖层 | ❌ | ✅ | — |

### 3.2 实施计划

#### Phase 1：附件系统移植（P0，预计 2-3 天）

1. **数据层**：扩展 `agent:send` IPC payload，增加 `attachments: Attachment[]` 字段（与 Chat 模式 `message:send` 对齐）。
2. **后端**：`agent-sdk-bridge.ts` 的 `sendMessage` 方法接受附件参数，将图片转为 SDK 支持的 `image` content block，文件路径转为 `text` 引用。
3. **前端组件**：
   - 在 `AgentChatInput.tsx` 中新增 `attachments` 状态管理（复用 Chat 的 `addAttachment`/`removeAttachment` 逻辑）。
   - 添加 `handlePaste`（读取剪贴板图片）、`handleDrop`（拖放文件/图片）、工具栏按钮（Paperclip + Image）。
   - 渲染 `AttachmentPreview` 组件（可从 ChatView 抽取为独立共享组件）。
4. **发送逻辑**：`canSend` 条件加入 `|| hasAttachments`；`onSend` 签名改为 `(text: string, attachments: Attachment[]) => void`。

#### Phase 2：体验对齐（P1，预计 1-2 天）

1. **拖放视觉反馈**：textarea 容器增加 `onDragOver`/`onDragLeave` 状态，高亮边框 + 占位文字切换。
2. **StreamActivityBar**：从 ChatView 抽取为共享组件，在 Agent 输入框上方显示当前工具活动（基于 `status` + 最新 tool_use block 名称）。
3. **Tab 键选中命令**：slash command 列表支持 Tab 确认（当前仅 Enter）。

#### Phase 3：增强功能（P2，预计 1 天）

1. **快捷操作 Chips**：空会话时显示 "Explain code"、"Fix bugs"、"Write tests" 等快捷入口。
2. **`/run` 命令**：对齐 Chat 模式的 Run App 功能。
3. **统一发送键行为**：提供设置项让用户选择 Enter 发送 or Cmd+Enter 发送（当前两模式行为相反，易混淆）。

---

## 四、整体体验优化方案

### 4.1 可靠性（修复核心 Bug）

| 优先级 | 任务 | 涉及文件 | 预计工时 |
|--------|------|----------|----------|
| P0 | 修复 Agent 双重发送（A1） | `AgentChatInput.tsx` | 0.5h |
| P0 | 修复 Chat stream:end 重载擦除内容（C1+C2）：改为增量持久化 contentBlocks JSON | `main.ts`, `message-repo.ts`, `App.tsx` | 4h |
| P0 | 修复 ERROR/INTERRUPTING 状态机死锁（C3+C4）：增加 ERROR→STOPPED 转换 + INTERRUPTING 超时回退 | `streamMachine.ts`, `App.tsx` | 2h |
| P0 | 处理 stdin EPIPE（C5）：为 child.stdin 添加 error listener + teardown 时关闭 | `cli-spawner.ts` | 1h |
| P0 | 修复 SDK 加载失败不可恢复（A3）：改为可重试的错误缓存 | `agent-sdk-bridge.ts` | 1h |
| P1 | 修复 Session ID 提前写入（A2）：SDK 确认后再持久化 | `agent-sdk-bridge.ts` | 1h |
| P1 | 修复权限请求挂起（A4+A12）：支持多权限队列 + 自动滚动到权限栏 | `agent-sdk-bridge.ts`, `AgentConversationView.tsx` | 3h |
| P1 | 修复中断后 tool_use 永久转圈（C10）：stream:end/error 时终结所有 pending blocks | `App.tsx` | 1h |
| P1 | 修复 file:search 全局对象错误（A11） | `AgentChatInput.tsx` | 0.5h |

### 4.2 性能优化

| 任务 | 说明 | 预计工时 |
|------|------|----------|
| IntersectionObserver 节流 | 流式期间用 `blocks.length` 的 debounce 替代逐帧重建 | 1h |
| toolUseMeta / changedFiles 清理 | tool_result 处理后删除对应 meta；changedFiles 去重并设上限 | 1h |
| Block ID 改用 nanoid/uuid | 避免 Date.now() 碰撞 | 0.5h |
| 消息列表虚拟滚动 | 长会话（100+ blocks）时引入 react-window 或分页渲染 | 4h |
| stream:end 避免全量重载 | 改为仅更新最后一条消息，不重新拉取整个会话 | 2h |

### 4.3 状态管理统一

当前 App.tsx 持有大量 useState（约 30+ 个状态变量），与 Zustand stores 并存，导致：
- 状态散落、prop drilling 严重
- 多窗口同步依赖手动广播
- 热更新/调试困难

**建议**：分阶段将 App.tsx 本地状态迁移至 Zustand stores：

1. **Phase A**：将 streaming 相关状态（streamState, isStreamActive, streamingConvId）合入 `chatStore`。
2. **Phase B**：将 conversations/messages 管理完全交由 `chatStore`，App.tsx 只做 selector 消费。
3. **Phase C**：Agent 模式状态（blocks, status, permission）抽为独立 `agentStore`。

### 4.4 类型安全加固

| 任务 | 说明 |
|------|------|
| 补全 Agent IPC 通道类型 | 在 `contracts.ts` 的 `InvokeMap` 和 `PushChannelMap` 中定义所有 `agent:*` 通道的 payload/response 类型 |
| 消除 `(event as any)` | `AgentConversationView.tsx` 中的事件处理改为 discriminated union 类型守卫 |
| 统一 Attachment 类型 | 抽取为 `shared/types.ts`，两模式共用 |

### 4.5 UX 细节打磨

| 任务 | 说明 | 优先级 |
|------|------|--------|
| 统一发送键行为 | 提供设置项或统一为 Cmd+Enter 发送 + Enter 换行 | P1 |
| Agent 错误恢复路径 | 错误时输入框不禁用，改为显示 inline 错误 + 重试按钮 | P1 |
| Abort 状态可视化 | 中止后显示 "Generation stopped" 分隔线 | P2 |
| 权限请求超时 | 60s 无响应自动 deny + toast 提示 | P2 |
| 空状态引导 | 新会话显示功能介绍 + 快捷操作 | P2 |
| 暗色/亮色主题切换动画 | 添加 CSS transition 避免闪烁 | P3 |
| 消息时间戳统一格式 | 全部使用 ISO 存储 + 前端 `Intl.DateTimeFormat` 渲染 | P3 |

### 4.6 代码架构改进

| 任务 | 说明 | 预计工时 |
|------|------|----------|
| 抽取共享输入组件 | 将 ChatView 内嵌输入框逻辑抽取为 `MessageInput` 共享组件，Agent/Chat 通过 props/config 差异化 | 6h |
| 抽取 AttachmentPreview | 独立组件 + 共享 hooks (`useAttachments`) | 2h |
| 抽取 StreamActivityBar | 独立组件，接受 activity label prop | 1h |
| 统一 Slash Command 注册 | 建立 command registry，两模式共享命令定义，差异化执行逻辑 | 3h |
| 错误边界细化 | 为 Agent/Chat 视图各添加独立 ErrorBoundary，避免一侧崩溃白屏 | 1h |

---

## 五、实施路线图

```
Week 1 (P0 - 稳定性)
├── Day 1-2: 修复 A1, C5, A3 (快速修复)
├── Day 2-4: 修复 C1+C2 (contentBlocks 持久化)
├── Day 4-5: 修复 C3+C4 (状态机死锁)
└── Day 5:   修复 A2, A11

Week 2 (P0/P1 - 功能补齐)
├── Day 1-3: Agent 附件系统 (Phase 1)
├── Day 3-4: 修复 A4+A12 (权限系统)
├── Day 4-5: 修复 C10, C6, C7

Week 3 (P1 - 体验对齐)
├── Day 1-2: 拖放反馈 + StreamActivityBar (Phase 2)
├── Day 2-3: 统一发送键 + 错误恢复路径
├── Day 3-5: 类型安全加固 (contracts.ts)

Week 4 (P2/P3 - 优化打磨)
├── Day 1-2: 性能优化 (虚拟滚动, Observer 节流)
├── Day 2-3: 状态管理迁移 Phase A
├── Day 3-4: UX 细节 (快捷 Chips, Abort 可视化, 超时)
└── Day 4-5: 代码重构 (共享组件抽取) + 回归测试
```

---

## 六、验收标准

1. **零数据丢失**：Chat 模式重启后 thinking/tool/diff 内容完整恢复；Agent 模式 session resume 不报错。
2. **零死锁**：任何操作序列（快速连发、中途 abort、CLI 崩溃、网络断开）后输入框可在 5s 内恢复可用。
3. **功能对等**：Agent 输入框支持图片粘贴/拖放/选择、文件附件、预览条，与 Chat 模式一致。
4. **类型覆盖**：所有 IPC 通道有完整 TypeScript 类型定义，`any` 使用减少 80% 以上。
5. **性能基线**：500 条消息会话滚动 FPS ≥ 55；流式渲染期间 CPU 占用下降 20%（Observer 优化）。

---

## 七、风险与注意事项

- **SDK 兼容性**：`@anthropic-ai/claude-agent-sdk` 尚处于早期阶段，附件（image block）支持需确认 SDK 版本文档。
- **CLI 版本碎片化**：用户本地 Claude CLI 版本不一，`--effort` 等参数需做 graceful fallback。
- **数据库迁移**：contentBlocks 持久化需要新增 migration（`002-content-blocks.sql`），对已有数据做兼容处理。
- **多窗口一致性**：修改持久化逻辑后需验证 `window:bind` 重放路径（C8）同步修复。
