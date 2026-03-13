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
    console.log(`[startStreaming] 被调用: streamingEnabled=${streamingEnabled}, hasCardTarget=${!!currentCardTarget}, isCreatingCard=${isCreatingCard}`);
    if (!streamingEnabled || currentCardTarget || isCreatingCard) {
      console.log(`[startStreaming] 跳过: streamingEnabled=${streamingEnabled}, hasCardTarget=${!!currentCardTarget}, isCreatingCard=${isCreatingCard}`);
      return;
    }
    
    isCreatingCard = true;  // ✅ 标记为创建中

    try {
      const target: AICardTarget = isDirect
        ? { type: 'user', userId: senderId }
        : { type: 'group', openConversationId: conversationId };
      
      console.log(`[startStreaming] 开始创建 AI Card: target=${JSON.stringify(target)}`);
      console.log(`[startStreaming] params.runtime keys: ${Object.keys(params.runtime).join(', ')}`);
      console.log(`[startStreaming] params.runtime.log=${typeof params.runtime.log}`);
      console.log(`[startStreaming] params.runtime.info=${typeof params.runtime.info}`);
      console.log(`[startStreaming] params.runtime.error=${typeof params.runtime.error}`);
      
      // 构建正确的 logger 对象
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
      console.log(`[startStreaming] createAICardForTarget 返回: card=${JSON.stringify(card)}`);
      currentCardTarget = card;
      console.log(`[startStreaming] currentCardTarget 已赋值: ${!!currentCardTarget}, cardId=${card?.cardInstanceId || 'null'}`);
      accumulatedText = "";
    } catch (error) {
      console.log(`[startStreaming] AI Card 创建失败: ${String(error)}`);
      params.runtime.error?.(
        `dingtalk[${account.accountId}]: streaming start failed: ${String(error)}`
      );
      currentCardTarget = null;
    } finally {
      isCreatingCard = false;  // ✅ 无论成功失败，都重置标志
    }
  };

  const closeStreaming = async () => {
    console.log(`[closeStreaming] 被调用: hasCardTarget=${!!currentCardTarget}`);
    if (!currentCardTarget) {
      console.log(`[closeStreaming] 跳过：没有 card target`);
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
      
      if (oapiToken) {
        // 处理本地图片
        finalText = await processLocalImages(finalText, oapiToken, logger);
        
        // 处理视频、音频、文件标记
        const target: AICardTarget = isDirect
          ? { type: 'user', userId: senderId }
          : { type: 'group', openConversationId: conversationId };
        
        finalText = await processVideoMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          logger,
          false,
          target
        );
        finalText = await processAudioMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          logger,
          false,
          target
        );
        finalText = await processFileMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          logger,
          false,
          target
        );
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
        console.log(`[onReplyStart] 被调用`);
        deliveredFinalTexts.clear();
        if (streamingEnabled) {
          console.log(`[onReplyStart] 开始等待 startStreaming...`);
          await startStreaming();
          console.log(`[onReplyStart] startStreaming 完成`);
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        console.log(`[deliver] 被调用: kind=${info?.kind}, streamingEnabled=${streamingEnabled}, hasCardTarget=${!!currentCardTarget}`);
        const text = payload.text ?? "";
        const hasText = Boolean(text.trim());
        console.log(`[deliver] text length=${text.length}, hasText=${hasText}`);
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText) {
          console.log(`[deliver] 跳过: shouldDeliverText=false`);
          return;
        }

        // 流式模式：使用 AI Card
        if (info?.kind === "block" && streamingEnabled) {
          console.log(`[deliver] 进入流式 block 分支`);
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
          console.log(`[deliver] 进入流式 final 分支: hasCardTarget=${!!currentCardTarget}`);
          
          // 如果还没有创建 AI Card，先创建
          if (!currentCardTarget && !isCreatingCard) {
            console.log(`[deliver] final 时还没有 card，启动流式...`);
            await startStreaming();
          }
          
          // 等待创建完成
          if (isCreatingCard) {
            console.log(`[deliver] final 时 AI Card 正在创建中，等待...`);
            const maxWait = 5000;
            const startTime = Date.now();
            while (isCreatingCard && Date.now() - startTime < maxWait) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            console.log(`[deliver] final 等待完成，currentCardTarget=${!!currentCardTarget}`);
          }
          
          console.log(`[deliver] 检查 currentCardTarget: ${!!currentCardTarget}, cardId=${currentCardTarget?.cardInstanceId || 'null'}`);
          
          if (currentCardTarget) {
            console.log(`[deliver] 更新 accumulatedText 并关闭流式`);
            accumulatedText = text;
            console.log(`[deliver] accumulatedText 已更新，长度=${accumulatedText.length}`);
            await closeStreaming();
            console.log(`[deliver] closeStreaming 完成`);
            deliveredFinalTexts.add(text);
            return;
          } else {
            console.log(`[deliver] AI Card 创建失败，降级到普通消息`);
            // 降级到普通消息发送（继续执行下面的代码）
          }
        }

        // 流式模式但没有 card target：降级到非流式发送
        // 或者非流式模式：使用普通消息发送
        if (info?.kind === "final") {
          console.log(`[deliver] 进入 final 分支（${streamingEnabled ? '流式降级' : '非流式'}）`);
          try {
            // 分块发送（如果文本过长）
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

        // 如果走到这里，说明没有匹配任何分支
        console.log(`[deliver] 警告：没有匹配任何发送分支！kind=${info?.kind}, streamingEnabled=${streamingEnabled}, hasCardTarget=${!!currentCardTarget}`);
      },
      onError: async (error, info) => {
        console.log(`[onError] 被调用: error=${String(error)}, kind=${info.kind}`);
        params.runtime.error?.(
          `dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(error)}`
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        console.log(`[onIdle] 被调用`);
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
        console.log(`[onPartialReply] 被调用: text length=${payload.text?.length || 0}`);
        if (!payload.text) {
          return;
        }
        
        // 如果还没有 AI Card，先启动流式
        if (!currentCardTarget && !isCreatingCard) {
          console.log(`[onPartialReply] 没有 card target，启动流式...`);
          await startStreaming();
          console.log(`[onPartialReply] startStreaming 完成后，currentCardTarget=${!!currentCardTarget}`);
        }
        
        // 如果正在创建中，等待创建完成
        if (isCreatingCard) {
          console.log(`[onPartialReply] AI Card 正在创建中，等待...`);
          // 简单的轮询等待，最多等待 5 秒
          const maxWait = 5000;
          const startTime = Date.now();
          while (isCreatingCard && Date.now() - startTime < maxWait) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          console.log(`[onPartialReply] 等待完成，currentCardTarget=${!!currentCardTarget}`);
        }
        
        if (currentCardTarget) {
          // ✅ 更新累积文本（始终更新，确保最终内容完整）
          accumulatedText = payload.text;
          
          // ✅ 节流更新：避免过于频繁调用钉钉 API
          const now = Date.now();
          if (now - lastUpdateTime >= updateInterval) {
            console.log(`[onPartialReply] 更新 AI Card: text length=${payload.text.length}`);
            
            // ✅ 实时清理媒体标记（避免用户在流式过程中看到标记）
            const { FILE_MARKER_PATTERN, VIDEO_MARKER_PATTERN, AUDIO_MARKER_PATTERN } = await import('./media.js');
            const displayContent = accumulatedText
              .replace(FILE_MARKER_PATTERN, '')
              .replace(VIDEO_MARKER_PATTERN, '')
              .replace(AUDIO_MARKER_PATTERN, '')
              .trim();
            
            // 构建正确的 logger 对象
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
              // ✅ 捕获限流错误，避免 Unhandled promise rejection
              if (err.response?.status === 403 && err.response?.data?.code?.includes('QpsLimit')) {
                console.log(`[onPartialReply] 遇到 QPS 限流，跳过本次更新`);
                // 不更新 lastUpdateTime，下次会重试
              } else {
                console.error(`[onPartialReply] AI Card 更新失败:`, err.message);
                throw err; // 其他错误继续抛出
              }
            }
          } else {
            console.log(`[onPartialReply] 节流跳过更新: 距上次更新 ${now - lastUpdateTime}ms < ${updateInterval}ms`);
          }
        } else {
          console.log(`[onPartialReply] 警告：AI Card 创建失败，无法流式更新`);
        }
      },
    }),
  };

  console.log(`[createDingtalkReplyDispatcher] finalReplyOptions keys:`, Object.keys(finalReplyOptions));
  console.log(`[createDingtalkReplyDispatcher] streamingEnabled:`, streamingEnabled);

  return {
    dispatcher,
    replyOptions: {
      ...finalReplyOptions,
      disableBlockStreaming: true,  // ✅ 强制使用 onPartialReply 而不是 block
    },
    markDispatchIdle,
  };
}
