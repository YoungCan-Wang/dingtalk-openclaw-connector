/**
 * 钉钉监控核心模块
 * 包含 monitorSingleAccount 和 resolveReactionSyntheticEvent
 * 独立出来以避免循环依赖问题
 */

import { DWClient } from 'dingtalk-stream';
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedDingtalkAccount } from "./types.ts";
import { 
  isMessageProcessed, 
  markMessageProcessed, 
} from "./utils.ts";
import { handleDingTalkMessage } from "./monitor.account.ts";

// ============ 类型定义 ============

export type DingtalkReactionCreatedEvent = {
  type: "reaction_created";
  channelId: string;
  messageId: string;
  userId: string;
  emoji: string;
};

export type MonitorDingtalkAccountOpts = {
  cfg: ClawdbotConfig;
  account: ResolvedDingtalkAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

// ============ 监控账号 ============

export async function monitorSingleAccount(opts: MonitorDingtalkAccountOpts): Promise<void> {
  const { cfg, account, runtime, abortSignal } = opts;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  if (!account.clientId || !account.clientSecret) {
    throw new Error(`DingTalk account "${accountId}" missing credentials`);
  }

  log(`[DingTalk][${accountId}] Starting DingTalk Stream client...`);

  const client = new DWClient({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    debug: false, // 关闭 SDK 的 debug 日志，减少噪音
  });

  return new Promise<void>((resolve, reject) => {
    // Handle abort signal
    if (abortSignal) {
      const onAbort = () => {
        log(`[DingTalk][${accountId}] Abort signal received, stopping...`);
        client.disconnect();
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // Register message handler
    console.log(`[DingTalk][${accountId}] 注册消息监听器...`);
    client.registerAllEventListener(async (res: any) => {
      const messageId = res.headers?.messageId;
      console.log(`[DingTalk][${accountId}] 收到 Stream 回调, messageId=${messageId}, hasData=${!!res.data}`);

      // 立即确认回调
      if (messageId) {
        client.socketCallBackResponse(messageId, { success: true });
        console.log(`[DingTalk][${accountId}] 已立即确认回调: messageId=${messageId}`);
      }

      // 消息去重
      if (messageId && isMessageProcessed(accountId, messageId)) {
        console.warn(`[DingTalk][${accountId}] 检测到重复消息，跳过处理: messageId=${messageId}`);
        return;
      }

      if (messageId) {
        markMessageProcessed(accountId, messageId);
      }

      // 异步处理消息
      try {
        const data = JSON.parse(res.data);
        console.log(`[DingTalk][${accountId}] 开始处理消息: accountId=${accountId}, hasConfig=${!!account.config}, dataKeys=${Object.keys(data).join(',')}`);
        
        await handleDingTalkMessage({
          accountId,
          config: account.config,
          data,
          sessionWebhook: data.sessionWebhook,
          runtime,
          log,
        });
        
        console.log(`[DingTalk][${accountId}] 消息处理完成`);
      } catch (error: any) {
        console.error(`[DingTalk][${accountId}] 处理消息异常: ${error.message}\n${error.stack}`);
      }
    });
    console.log(`[DingTalk][${accountId}] 消息监听器注册完成`);

    // Connect to DingTalk Stream
    client.connect()
      .then(() => {
        log(`[DingTalk][${accountId}] Connected to DingTalk Stream`);
      })
      .catch((err) => {
        log(`[DingTalk][${accountId}] Failed to connect: ${err.message}`);
        reject(err);
      });

    // 连接状态追踪
    let connectionStartTime = Date.now();
    let reconnectCount = 0;

    // Handle disconnection
    client.on('close', () => {
      const connectionDuration = Date.now() - connectionStartTime;
      log(`[DingTalk][${accountId}] Connection closed after ${Math.round(connectionDuration / 1000)}s`);
      resolve();
    });

    client.on('error', (err: Error) => {
      log(`[DingTalk][${accountId}] Connection error: ${err.message}`);
      reject(err);
    });

    // 监听重连事件（如果 SDK 支持）
    client.on('reconnect', () => {
      reconnectCount++;
      connectionStartTime = Date.now();
      log(`[DingTalk][${accountId}] Reconnecting... (attempt ${reconnectCount})`);
    });

    client.on('reconnected', () => {
      log(`[DingTalk][${accountId}] Reconnected successfully after ${reconnectCount} attempts`);
    });
  });
}

export function resolveReactionSyntheticEvent(
  event: any,
): DingtalkReactionCreatedEvent | null {
  // DingTalk doesn't support reactions in the same way as Feishu
  return null;
}
