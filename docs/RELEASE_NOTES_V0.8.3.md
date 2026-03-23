# Release Notes - v0.8.3

## 🎉 新版本亮点 / Highlights

本次更新修复了四个问题：多 Agent 路由在 `sharedMemoryAcrossConversations` 配置下的路由错误、发送图片时的异常问题、发送人昵称和群名称未正确传递给 AI 的问题，以及 AI 卡片流式更新（progressive updates）失效的问题。

This release fixes four issues: incorrect multi-Agent routing when `sharedMemoryAcrossConversations` is enabled, an image sending failure, sender nickname and group name not being correctly passed to the AI, and AI card progressive updates not working.

## 🐛 修复 / Fixes

- **AI 卡片流式更新失效 / AI Card Progressive Updates Not Working**  
  修复了 AI 卡片无法逐步更新（progressive updates）的问题，表现为 AI 卡片等完整回复生成后才一次性出现，而非逐步显示。根因有两处：① `onReplyStart` 回调中 `await startStreaming()` 阻塞了 SDK 的回复生命周期启动，导致 AI Card 创建与 AI 生成文字串行而非并行；② 流式更新节流间隔设置为 1000ms 过于保守，对于 2 秒内完成的短回复几乎跳过所有中间更新。修复后，AI Card 创建改为 fire-and-forget 模式与 AI 生成并行，节流间隔调整为 500ms。  
  Fixed an issue where AI card progressive updates were not working — the card would only appear after the full reply was generated instead of updating incrementally. Two root causes were identified: ① `await startStreaming()` in `onReplyStart` blocked the SDK reply lifecycle, causing AI Card creation and AI generation to run serially instead of in parallel; ② the streaming throttle interval of 1000ms was too conservative, skipping nearly all intermediate updates for short replies. After the fix, AI Card creation runs in fire-and-forget mode in parallel with AI generation, and the throttle interval is reduced to 500ms.

- **消息重复处理（钉钉服务端重发穿透）/ Duplicate Message Processing on DingTalk Server Resend**  
  修复了 AI 处理耗时超过 ~60 秒时，钉钉服务端重发消息导致 Bot 重复处理的问题。根因是去重逻辑仅使用 `headers.messageId`（WebSocket 协议层投递 ID，每次重发都是新值），未检查 `data.msgId`（业务层消息 ID，重发时保持不变），导致重发消息穿透去重缓存。修复后引入双层去重：协议层（`headers.messageId`）拦截同一次投递的重复回调，业务层（`data.msgId`）拦截服务端重发，两个 ID 同时标记，任意一个命中即可拦截。  
  Fixed an issue where DingTalk server resent messages (triggered when AI processing exceeds ~60 seconds) caused the Bot to process the same message twice. The root cause was that deduplication only checked `headers.messageId` (WebSocket protocol-layer delivery ID, which changes on every resend), ignoring `data.msgId` (business-layer message ID, which stays the same on resend). After the fix, a two-layer deduplication is applied: protocol-layer (`headers.messageId`) blocks duplicate callbacks from the same delivery, and business-layer (`data.msgId`) blocks server resends. Both IDs are marked simultaneously so either one can trigger deduplication.

- **多 Agent 路由与 sharedMemoryAcrossConversations 冲突 / Multi-Agent Routing Conflict with sharedMemoryAcrossConversations**  
  修复了配置 `sharedMemoryAcrossConversations: true` 时，多群分配不同 Agent 的 bindings 全部路由到同一个 Agent 的问题。根因是路由匹配错误地使用了 `sessionPeerId`（已被覆盖为 `accountId`）而非真实的 peer 标识。修复后，路由匹配使用专用的 `peerId` 字段（不受会话隔离配置影响），session 构建使用 `sessionPeerId`，两者职责严格分离。  
  Fixed an issue where all bindings routing different groups to different Agents would resolve to the same Agent when `sharedMemoryAcrossConversations: true` was configured. The root cause was that routing matched against `sessionPeerId` (overridden to `accountId`) instead of the real peer identifier. After the fix, routing uses the dedicated `peerId` field (unaffected by session isolation config), while session construction uses `sessionPeerId`, with strict separation of responsibilities.

- **发送图片失败 / Image Sending Failure**  
  修复了发送图片时出现异常的问题。([#316](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/issues/316))  
  Fixed an issue where sending images would fail with an error. ([#316](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/issues/316))

- **发送人昵称与群名称未正确传递给 AI / Sender Nickname and Group Name Not Passed to AI**  
  修复了会话上下文中 `SenderName` 字段错误传入用户 ID（而非昵称）、`GroupSubject` 字段错误传入群 ID（而非群名称）的问题。修复后，AI 能正确获取发送人的钉钉昵称和所在群的名称，有助于 AI 更好地理解对话场景。  
  Fixed an issue where the `SenderName` field in the session context was incorrectly set to the user ID instead of the display name, and `GroupSubject` was set to the group ID instead of the group title. After the fix, the AI correctly receives the sender's DingTalk nickname and the group name, enabling better contextual understanding.

## 📥 安装升级 / Installation & Upgrade

```bash
# 通过 npm 安装最新版本 / Install latest version via npm
openclaw plugins install @dingtalk-real-ai/dingtalk-connector

# 或升级现有版本 / Or upgrade existing version
openclaw plugins update dingtalk-connector

# 通过 Git 安装 / Install via Git
openclaw plugins install https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector.git
```

## 🔗 相关链接 / Related Links

- [完整变更日志 / Full Changelog](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/CHANGELOG.md)
- [使用文档 / Documentation](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/README.md)

---

**发布日期 / Release Date**：2026-03-23  
**版本号 / Version**：v0.8.3  
**兼容性 / Compatibility**：OpenClaw Gateway 0.4.0+