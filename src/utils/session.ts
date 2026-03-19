/**
 * 会话管理模块
 * 构建 OpenClaw 标准会话上下文
 */

import { NEW_SESSION_COMMANDS } from './constants.ts';

/** OpenClaw 标准会话上下文 */
export interface SessionContext {
  channel: 'dingtalk-connector';
  accountId: string;
  chatType: 'direct' | 'group';
  peerId: string;
  conversationId?: string;
  senderName?: string;
  groupSubject?: string;
}

/**
 * 构建 OpenClaw 标准会话上下文
 * 遵循 OpenClaw session.dmScope 机制，让 Gateway 根据配置自动处理会话隔离
 * 
 * @param sharedMemoryAcrossConversations - 是否在不同会话间共享记忆（默认 false）
 *   - true: 所有会话共享记忆，使用 accountId 作为记忆标识
 *   - false: 不同会话独立记忆，使用完整的 sessionContext 作为记忆标识
 */
export function buildSessionContext(params: {
  accountId: string;
  senderId: string;
  senderName?: string;
  conversationType: string;
  conversationId?: string;
  groupSubject?: string;
  separateSessionByConversation?: boolean;
  groupSessionScope?: 'group' | 'group_sender';
  sharedMemoryAcrossConversations?: boolean;
}): SessionContext {
  const {
    accountId,
    senderId,
    senderName,
    conversationType,
    conversationId,
    groupSubject,
    separateSessionByConversation,
    groupSessionScope,
    sharedMemoryAcrossConversations,
  } = params;
  const isDirect = conversationType === '1';

  // sharedMemoryAcrossConversations=true 时，所有会话共享记忆
  // 通过将 peerId 设置为 accountId 来实现跨会话记忆共享
  if (sharedMemoryAcrossConversations === true) {
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: isDirect ? 'direct' : 'group',
      peerId: accountId, // 使用 accountId 作为 peerId，实现跨会话记忆共享
      conversationId: isDirect ? undefined : conversationId,
      senderName,
      groupSubject: isDirect ? undefined : groupSubject,
    };
  }

  if (separateSessionByConversation === false) {
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: isDirect ? 'direct' : 'group',
      peerId: senderId,
      senderName,
    };
  }

  if (isDirect) {
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: 'direct',
      peerId: senderId,
      senderName,
    };
  }

  if (groupSessionScope === 'group_sender') {
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: 'group',
      peerId: `${conversationId}:${senderId}`,
      conversationId,
      senderName,
      groupSubject,
    };
  }

  return {
    channel: 'dingtalk-connector',
    accountId,
    chatType: 'group',
    peerId: conversationId || senderId,
    conversationId,
    senderName,
    groupSubject,
  };
}

/**
 * 检查消息是否是新会话命令
 */
export function normalizeSlashCommand(text: string): string {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (NEW_SESSION_COMMANDS.some((cmd) => lower === cmd.toLowerCase())) {
    return '/new';
  }
  return text;
}
