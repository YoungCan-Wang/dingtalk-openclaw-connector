import type {
  ClawdbotConfig,
  RuntimeEnv,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
} from "openclaw/plugin-sdk";
import { resolveDingtalkAccount } from "./accounts.js";
import { getDingtalkRuntime } from "./runtime.js";
import type { DingtalkConfig } from "./types.js";
import {
  createAICardForTarget,
  streamAICard,
  finishAICard,
  sendMessage,
  type AICardTarget,
  type AICardInstance,
} from "./messaging.js";
import {
  processLocalImages,
  processVideoMarkers,
  processAudioMarkers,
  processFileMarkers,
} from "./media.js";
import { getAccessToken, getOapiAccessToken } from "./utils.js";

// ============ 新会话命令归一化 ============

/** 新会话触发命令 */
const NEW_SESSION_COMMANDS = ['/new', '/reset', '/clear', '新会话', '重新开始', '清空对话'];

/**
 * 将新会话命令归一化为标准的 /new 命令
 * 支持多种别名：/new、/reset、/clear、新会话、重新开始、清空对话
 */
export function normalizeSlashCommand(text: string): string {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (NEW_SESSION_COMMANDS.some(cmd => lower === cmd.toLowerCase())) {
    return '/new';
  }
  return text;
}

export type CreateDingtalkReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  conversationId: string;
  senderId: string;
  isDirect: boolean;
  accountId?: string;
  messageCreateTimeMs?: number;
  sessionWebhook: string;
  asyncMode?: boolean;
};

export function createDingtalkReplyDispatcher(params: CreateDingtalkReplyDispatcherParams) {
  const core = getDingtalkRuntime();
  const {
    cfg,
    agentId,
    conversationId,
    senderId,
    isDirect,
    accountId,
    sessionWebhook,
    asyncMode = false,
  } = params;

  const account = resolveDingtalkAccount({ cfg, accountId });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: "dingtalk-connector",
    accountId,
  });

  // AI Card 状态管理
  let currentCardTarget: AICardTarget | null = null;
  let accumulatedText = "";
  const deliveredFinalTexts = new Set<string>();
  
  // 异步模式：累积完整响应
  let asyncModeFullResponse = "";
  
  // ✅ 节流控制：避免频繁调用钉钉 API 导致 QPS 限流
  let lastUpdateTime = 0;
  const updateInterval = 1000; // 最小更新间隔 1000ms（钉钉 QPS 限制：40次/秒，安全起见设为 1 秒）

  // 打字指示器回调（钉钉暂不支持，预留接口）
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // 钉钉暂不支持打字指示器
    },
    stop: async () => {
      // 钉钉暂不支持打字指示器
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "dingtalk-connector",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "dingtalk-connector",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    cfg,
    "dingtalk-connector",
    accountId,
    { fallbackLimit: 4000 }
  );
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "dingtalk-connector");

  // 流式 AI Card 支持
  const streamingEnabled = account.config?.streaming !== false;
  let isCreatingCard = false;  // ✅ 添加创建中标志，防止并发创建

  const startStreaming = async () => {
    // 异步模式下禁用流式 AI Card
    if (asyncMode) {
      return;
    }
    if (!streamingEnabled || currentCardTarget || isCreatingCard) {
      return;
    }
    
    isCreatingCard = true;

    try {
      const target: AICardTarget = isDirect
        ? { type: 'user', userId: senderId }
        : { type: 'group', openConversationId: conversationId };
      
      const logger = {
        info: params.runtime.info,
        error: params.runtime.error,
        warn: params.runtime.warn,
        debug: params.runtime.debug,
      };
      
      const card = await createAICardForTarget(
        account.config as DingtalkConfig,
        target,
        logger
      );
      currentCardTarget = card;
      accumulatedText = "";
    } catch (error) {
      params.runtime.error?.(
        `dingtalk[${account.accountId}]: streaming start failed: ${String(error)}`
      );
      currentCardTarget = null;
    } finally {
      isCreatingCard = false;
    }
  };

  const closeStreaming = async () => {
    if (!currentCardTarget) {
      return;
    }

    try {
      // 处理媒体标记
      let finalText = accumulatedText;
      
      // 获取 oapiToken 用于媒体处理
      const oapiToken = await getOapiAccessToken(account.config as DingtalkConfig);
      
      // 构建正确的 logger 对象
      const logger = {
        info: params.runtime.info,
        error: params.runtime.error,
        warn: params.runtime.warn,
        debug: params.runtime.debug,
      };
      
      // ✅ 构建正确的 target（单聊用 senderId，群聊用 conversationId）
      const target: AICardTarget = isDirect
        ? { type: 'user', userId: senderId }
        : { type: 'group', openConversationId: conversationId };
      
      logger?.info?.(`[DingTalk][closeStreaming] 开始处理媒体文件，target=${JSON.stringify(target)}`);
      
      if (oapiToken) {
        // 处理本地图片
        finalText = await processLocalImages(finalText, oapiToken, logger);
        
        // ✅ 先处理 Markdown 标记格式的媒体文件
        finalText = await processVideoMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          logger,
          true,  // ✅ 使用主动 API 模式
          target
        );
        finalText = await processAudioMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          logger,
          true,  // ✅ 使用主动 API 模式
          target
        );
        finalText = await processFileMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          logger,
          true,  // ✅ 使用主动 API 模式
          target
        );
        
        // ✅ 处理裸露的本地文件路径（绕过 OpenClaw SDK 的 bug）
        logger?.info?.(`[DingTalk][closeStreaming] 准备调用 processRawMediaPaths`);
        const { processRawMediaPaths } = await import('./media.js');
        finalText = await processRawMediaPaths(
          finalText,
          account.config as DingtalkConfig,
          oapiToken,
          logger,
          target
        );
        logger?.info?.(`[DingTalk][closeStreaming] processRawMediaPaths 处理完成`);
      } else {
        logger?.warn?.(`[DingTalk][closeStreaming] oapiToken 为空，跳过媒体处理`);
      }

      await finishAICard(
        currentCardTarget as AICardInstance,
        finalText,
        logger
      );
    } catch (error) {
      params.runtime.error?.(
        `dingtalk[${account.accountId}]: streaming close failed: ${String(error)}`
      );
    } finally {
      currentCardTarget = null;
      accumulatedText = "";
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: async () => {
        deliveredFinalTexts.clear();
        if (streamingEnabled) {
          await startStreaming();
        }
        typingCallbacks.onActive?.();
      },
      deliver: async (payload, info) => {
        let text = payload.text ?? "";
        
        // ✅ 添加日志追踪
        params.runtime.info?.(`[DingTalk][deliver] 被调用: kind=${info?.kind}, textLength=${text.length}, hasText=${Boolean(text.trim())}`);
        
        // ✅ 在 final 响应时，先处理裸露的文件路径
        if (info?.kind === "final" && text.trim()) {
          const logger = {
            info: params.runtime.info,
            error: params.runtime.error,
            warn: params.runtime.warn,
            debug: params.runtime.debug,
          };
          
          const target: AICardTarget = isDirect
            ? { type: 'user', userId: senderId }
            : { type: 'group', openConversationId: conversationId };
          
          try {
            const oapiToken = await getOapiAccessToken(account.config as DingtalkConfig);
            if (oapiToken) {
              logger?.info?.(`[DingTalk][deliver] 检测到 final 响应，准备处理裸露文件路径`);
              const { processRawMediaPaths } = await import('./media.js');
              text = await processRawMediaPaths(
                text,
                account.config as DingtalkConfig,
                oapiToken,
                logger,
                target
              );
              logger?.info?.(`[DingTalk][deliver] 裸露文件路径处理完成`);
            }
          } catch (err: any) {
            logger?.error?.(`[DingTalk][deliver] 处理裸露文件路径失败: ${err.message}`);
          }
        }
        
        const hasText = Boolean(text.trim());
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText) {
          return;
        }

        // 异步模式：只累积响应，不发送
        if (asyncMode) {
          asyncModeFullResponse = text;
          return;
        }

        // 流式模式：使用 AI Card
        if (info?.kind === "block" && streamingEnabled) {
          if (!currentCardTarget) {
            await startStreaming();
          }
          if (currentCardTarget) {
            accumulatedText += text;
            await streamAICard(
              currentCardTarget as AICardInstance,
              accumulatedText,
              false,
              params.runtime.log
            );
          }
          return;
        }

        // 流式模式的 final 处理
        if (info?.kind === "final" && streamingEnabled) {
          // 如果还没有创建 AI Card，先创建
          if (!currentCardTarget && !isCreatingCard) {
            await startStreaming();
          }
          
          // 等待创建完成
          if (isCreatingCard) {
            const maxWait = 5000;
            const startTime = Date.now();
            while (isCreatingCard && Date.now() - startTime < maxWait) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          
          if (currentCardTarget) {
            accumulatedText = text;
            await closeStreaming();
            deliveredFinalTexts.add(text);
            return;
          }
        }

        // 流式模式但没有 card target：降级到非流式发送
        // 或者非流式模式：使用普通消息发送
        if (info?.kind === "final") {
          try {
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode
            )) {
              await sendMessage(
                account.config as DingtalkConfig,
                sessionWebhook,
                chunk,
                {
                  useMarkdown: true,
                  log: params.runtime.log,
                }
              );
            }
            deliveredFinalTexts.add(text);
          } catch (error) {
            params.runtime.error?.(
              `dingtalk[${account.accountId}]: non-streaming delivery failed: ${String(error)}`
            );
          }
          return;
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(error)}`
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  // 构建完整的 replyOptions
  const finalReplyOptions = {
    onModelSelected,
    ...(streamingEnabled && {
      onPartialReply: async (payload: ReplyPayload) => {
        if (!payload.text) {
          return;
        }
        
        // 异步模式下禁用流式更新
        if (asyncMode) {
          asyncModeFullResponse = payload.text;
          return;
        }
        
        // 如果还没有 AI Card，先启动流式
        if (!currentCardTarget && !isCreatingCard) {
          await startStreaming();
        }
        
        // 如果正在创建中，等待创建完成
        if (isCreatingCard) {
          const maxWait = 5000;
          const startTime = Date.now();
          while (isCreatingCard && Date.now() - startTime < maxWait) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        
        if (currentCardTarget) {
          accumulatedText = payload.text;
          
          const now = Date.now();
          if (now - lastUpdateTime >= updateInterval) {
            const { FILE_MARKER_PATTERN, VIDEO_MARKER_PATTERN, AUDIO_MARKER_PATTERN } = await import('./media.js');
            const displayContent = accumulatedText
              .replace(FILE_MARKER_PATTERN, '')
              .replace(VIDEO_MARKER_PATTERN, '')
              .replace(AUDIO_MARKER_PATTERN, '')
              .trim();
            
            const logger = {
              info: params.runtime.info,
              error: params.runtime.error,
              warn: params.runtime.warn,
              debug: params.runtime.debug,
            };
            
            try {
              await streamAICard(
                currentCardTarget as AICardInstance,
                displayContent,
                false,
                logger
              );
              lastUpdateTime = now;
            } catch (err: any) {
              // 安全检查：确保 code 存在且为字符串
              const errorCode = err.response?.data?.code;
              if (err.response?.status === 403 && typeof errorCode === 'string' && errorCode.includes('QpsLimit')) {
                // QPS 限流，跳过本次更新
                logger?.warn?.(`[DingTalk][AICard] QPS 限流，跳过本次更新`);
              } else {
                throw err;
              }
            }
          }
        }
      },
    }),
  };

  return {
    dispatcher,
    replyOptions: {
      ...finalReplyOptions,
      disableBlockStreaming: true,  // ✅ 强制使用 onPartialReply 而不是 block
    },
    markDispatchIdle,
    getAsyncModeResponse: () => asyncModeFullResponse,
  };
}
