import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import type { ResolvedDingtalkAccount, DingtalkConfig } from "./types";
import { 
  isMessageProcessed, 
  markMessageProcessed, 
  buildSessionContext,
  getAccessToken,
  getOapiAccessToken,
  DINGTALK_API,
  DINGTALK_OAPI
} from "./utils";
import { 
  processLocalImages, 
  processVideoMarkers, 
  processAudioMarkers, 
  processFileMarkers,
  uploadMediaToDingTalk,
  toLocalPath,
  FILE_MARKER_PATTERN,
  VIDEO_MARKER_PATTERN,
  AUDIO_MARKER_PATTERN
} from "./media";
import { createDingtalkReplyDispatcher, normalizeSlashCommand } from "./reply-dispatcher.js";
import { getDingtalkRuntime } from "./runtime.js";
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============ 常量 ============

const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';

const AICardStatus = {
  PROCESSING: '1',
  INPUTING: '2',
  FINISHED: '3',
  EXECUTING: '4',
  FAILED: '5',
} as const;

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

// ============ Agent 路由解析 ============
// SDK 会自动处理 bindings 解析，无需手动实现

// ============ 消息内容提取 ============

interface ExtractedMessage {
  text: string;
  messageType: string;
  imageUrls: string[];
  downloadCodes: string[];
  fileNames: string[];
  atDingtalkIds: string[];
  atMobiles: string[];
}

function extractMessageContent(data: any): ExtractedMessage {
  const msgtype = data.msgtype || 'text';
  switch (msgtype) {
    case 'text': {
      const atDingtalkIds = data.text?.at?.atDingtalkIds || [];
      const atMobiles = data.text?.at?.atMobiles || [];
      return { 
        text: data.text?.content?.trim() || '', 
        messageType: 'text', 
        imageUrls: [], 
        downloadCodes: [], 
        fileNames: [],
        atDingtalkIds,
        atMobiles
      };
    }
    case 'richText': {
      const parts = data.content?.richText || [];
      const textParts: string[] = [];
      const imageUrls: string[] = [];

      for (const part of parts) {
        if (part.text) {
          textParts.push(part.text);
        }
        if (part.pictureUrl) {
          imageUrls.push(part.pictureUrl);
        }
        if (part.type === 'picture' && part.downloadCode) {
          imageUrls.push(`downloadCode:${part.downloadCode}`);
        }
      }

      const text = textParts.join('') || (imageUrls.length > 0 ? '[图片]' : '[富文本消息]');
      return { text, messageType: 'richText', imageUrls, downloadCodes: [], fileNames: [], atDingtalkIds: [], atMobiles: [] };
    }
    case 'picture': {
      const downloadCode = data.content?.downloadCode || '';
      const pictureUrl = data.content?.pictureUrl || '';
      const imageUrls: string[] = [];
      const downloadCodes: string[] = [];

      if (pictureUrl) {
        imageUrls.push(pictureUrl);
      }
      if (downloadCode) {
        downloadCodes.push(downloadCode);
      }

      return { text: '[图片]', messageType: 'picture', imageUrls, downloadCodes, fileNames: [], atDingtalkIds: [], atMobiles: [] };
    }
    case 'audio':
      return { text: data.content?.recognition || '[语音消息]', messageType: 'audio', imageUrls: [], downloadCodes: [], fileNames: [], atDingtalkIds: [], atMobiles: [] };
    case 'video':
      return { text: '[视频]', messageType: 'video', imageUrls: [], downloadCodes: [], fileNames: [], atDingtalkIds: [], atMobiles: [] };
    case 'file': {
      const fileName = data.content?.fileName || '文件';
      const downloadCode = data.content?.downloadCode || '';
      const downloadCodes: string[] = [];
      const fileNames: string[] = [];
      if (downloadCode) {
        downloadCodes.push(downloadCode);
        fileNames.push(fileName);
      }
      return { text: `[文件: ${fileName}]`, messageType: 'file', imageUrls: [], downloadCodes, fileNames, atDingtalkIds: [], atMobiles: [] };
    }
    default:
      return { text: data.text?.content?.trim() || `[${msgtype}消息]`, messageType: msgtype, imageUrls: [], downloadCodes: [], fileNames: [], atDingtalkIds: [], atMobiles: [] };
  }
}

// ============ 图片下载 ============

async function downloadImageToFile(
  downloadUrl: string,
  log?: any,
): Promise<string | null> {
  try {
    log?.info?.(`[DingTalk][Image] 开始下载图片: ${downloadUrl.slice(0, 100)}...`);
    const resp = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000,
    });

    const buffer = Buffer.from(resp.data);
    const contentType = resp.headers['content-type'] || 'image/jpeg';
    const ext = contentType.includes('png') ? '.png' : contentType.includes('gif') ? '.gif' : contentType.includes('webp') ? '.webp' : '.jpg';
    const mediaDir = path.join(os.homedir(), '.openclaw', 'workspace', 'media', 'inbound');
    fs.mkdirSync(mediaDir, { recursive: true });
    const tmpFile = path.join(mediaDir, `openclaw-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(tmpFile, buffer);

    log?.info?.(`[DingTalk][Image] 图片下载成功: size=${buffer.length} bytes, type=${contentType}, path=${tmpFile}`);
    return tmpFile;
  } catch (err: any) {
    log?.error?.(`[DingTalk][Image] 图片下载失败: ${err.message}`);
    return null;
  }
}

async function downloadMediaByCode(
  downloadCode: string,
  config: DingtalkConfig,
  log?: any,
): Promise<string | null> {
  try {
    const token = await getAccessToken(config);
    log?.info?.(`[DingTalk][Image] 通过 downloadCode 下载媒体: ${downloadCode.slice(0, 30)}...`);

    const resp = await axios.post(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      { downloadCode, robotCode: config.clientId },
      {
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        timeout: 30_000,
      },
    );

    const downloadUrl = resp.data?.downloadUrl;
    if (!downloadUrl) {
      log?.warn?.(`[DingTalk][Image] downloadCode 换取 downloadUrl 失败: ${JSON.stringify(resp.data)}`);
      return null;
    }

    return downloadImageToFile(downloadUrl, log);
  } catch (err: any) {
    log?.error?.(`[DingTalk][Image] downloadCode 下载失败: ${err.message}`);
    return null;
  }
}

async function downloadFileByCode(
  downloadCode: string,
  fileName: string,
  config: DingtalkConfig,
  log?: any,
): Promise<string | null> {
  try {
    const token = await getAccessToken(config);
    log?.info?.(`[DingTalk][File] 通过 downloadCode 下载文件: ${fileName}`);

    const resp = await axios.post(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      { downloadCode, robotCode: config.clientId },
      {
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        timeout: 30_000,
      },
    );

    const downloadUrl = resp.data?.downloadUrl;
    if (!downloadUrl) {
      log?.warn?.(`[DingTalk][File] downloadCode 换取 downloadUrl 失败: ${JSON.stringify(resp.data)}`);
      return null;
    }

    const fileResp = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    });

    const buffer = Buffer.from(fileResp.data);
    const mediaDir = path.join(os.homedir(), '.openclaw', 'workspace', 'media', 'inbound');
    fs.mkdirSync(mediaDir, { recursive: true });

    const safeFileName = fileName.replace(/[/\\:*?"<>|]/g, '_');
    const localPath = path.join(mediaDir, `${Date.now()}-${safeFileName}`);
    fs.writeFileSync(localPath, buffer);

    log?.info?.(`[DingTalk][File] 文件下载成功: size=${buffer.length} bytes, path=${localPath}`);
    return localPath;
  } catch (err: any) {
    log?.error?.(`[DingTalk][File] 文件下载失败: ${err.message}`);
    return null;
  }
}

// ============ 消息处理 ============

interface HandleMessageParams {
  accountId: string;
  config: DingtalkConfig;
  data: any;
  sessionWebhook: string;
  runtime?: RuntimeEnv;
  log?: any;
  cfg: ClawdbotConfig;
}

export async function handleDingTalkMessage(params: HandleMessageParams): Promise<void> {
  const { accountId, config, data, sessionWebhook, runtime, log, cfg } = params;

  const content = extractMessageContent(data);
  if (!content.text && content.imageUrls.length === 0 && content.downloadCodes.length === 0) return;

  const isDirect = data.conversationType === '1';
  const senderId = data.senderStaffId || data.senderId;
  const senderName = data.senderNick || 'Unknown';

  log?.info?.(`[DingTalk] 收到消息: from=${senderName} type=${content.messageType} text="${content.text.slice(0, 50)}..." images=${content.imageUrls.length} downloadCodes=${content.downloadCodes.length}`);

  // ===== DM Policy 检查 =====
  if (isDirect) {
    const dmPolicy = config.dmPolicy || 'open';
    const allowFrom: string[] = config.allowFrom || [];
    if (dmPolicy === 'allowlist' && allowFrom.length > 0 && !allowFrom.includes(senderId)) {
      log?.warn?.(`[DingTalk] DM 被拦截: senderId=${senderId} 不在 allowFrom 白名单中`);
      return;
    }
  }

  // 构建会话上下文
  const sessionContext = buildSessionContext({
    accountId,
    senderId,
    senderName,
    conversationType: data.conversationType,
    conversationId: data.conversationId,
    groupSubject: data.conversationTitle,
    separateSessionByConversation: config.separateSessionByConversation,
    groupSessionScope: config.groupSessionScope,
  });
  const sessionContextJson = JSON.stringify(sessionContext);
  log?.info?.(`[DingTalk][Session] context=${sessionContextJson}`);

  // 构建消息内容
  // ✅ 使用 normalizeSlashCommand 归一化新会话命令
  const rawText = content.text || '';
  
  // 归一化命令（将 /reset、/clear、新会话 等别名统一为 /new）
  const normalizedText = normalizeSlashCommand(rawText);
  let userContent = normalizedText || (content.imageUrls.length > 0 ? '请描述这张图片' : '');

  // ===== 图片下载到本地文件 =====
  const imageLocalPaths: string[] = [];
  for (const url of content.imageUrls) {
    if (url.startsWith('downloadCode:')) {
      const code = url.slice('downloadCode:'.length);
      const localPath = await downloadMediaByCode(code, config, log);
      if (localPath) imageLocalPaths.push(localPath);
    } else {
      const localPath = await downloadImageToFile(url, log);
      if (localPath) imageLocalPaths.push(localPath);
    }
  }

  for (let i = 0; i < content.downloadCodes.length; i++) {
    const code = content.downloadCodes[i];
    const fileName = content.fileNames[i];
    if (!fileName) {
      const localPath = await downloadMediaByCode(code, config, log);
      if (localPath) imageLocalPaths.push(localPath);
    }
  }

  if (imageLocalPaths.length > 0) {
    log?.info?.(`[DingTalk][Image] 成功下载 ${imageLocalPaths.length} 张图片到本地`);
  }

  // ===== 文件附件下载与内容提取 =====
  const TEXT_FILE_EXTENSIONS = new Set(['.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.csv', '.log', '.ts', '.js', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.css', '.html', '.sql', '.sh', '.bat']);
  const OFFICE_FILE_EXTENSIONS = new Set(['.docx', '.pdf']);

  const fileContentParts: string[] = [];
  for (let i = 0; i < content.downloadCodes.length; i++) {
    const code = content.downloadCodes[i];
    const fileName = content.fileNames[i];
    if (!fileName) continue;

    const ext = path.extname(fileName).toLowerCase();
    const localPath = await downloadFileByCode(code, fileName, config, log);

    if (!localPath) {
      fileContentParts.push(`[文件下载失败: ${fileName}]`);
      continue;
    }

    if (TEXT_FILE_EXTENSIONS.has(ext)) {
      try {
        const fileContent = fs.readFileSync(localPath, 'utf-8');
        const maxLen = 50_000;
        const truncated = fileContent.length > maxLen ? fileContent.slice(0, maxLen) + '\n...(内容过长，已截断)' : fileContent;
        fileContentParts.push(`[文件: ${fileName}]\n\`\`\`\n${truncated}\n\`\`\``);
        log?.info?.(`[DingTalk][File] 文本文件已读取: ${fileName}, size=${fileContent.length}`);
      } catch (err: any) {
        log?.error?.(`[DingTalk][File] 读取文本文件失败: ${err.message}`);
        fileContentParts.push(`[文件已保存: ${localPath}，但读取内容失败]`);
      }
    } else if (ext === '.docx') {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.default.extractRawText({ path: localPath });
        const fileContent = result.value;
        const maxLen = 50_000;
        const truncated = fileContent.length > maxLen ? fileContent.slice(0, maxLen) + '\n...(内容过长，已截断)' : fileContent;
        fileContentParts.push(`[文件: ${fileName}]\n\`\`\`\n${truncated}\n\`\`\``);
        log?.info?.(`[DingTalk][File] Word 文档已提取文本: ${fileName}, size=${fileContent.length}`);
      } catch (err: any) {
        log?.error?.(`[DingTalk][File] Word 文档文本提取失败: ${err.message}`);
        fileContentParts.push(`[文件已保存: ${localPath}，但提取文本失败]`);
      }
    } else if (ext === '.pdf') {
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const dataBuffer = fs.readFileSync(localPath);
        const pdfData = await pdfParse(dataBuffer);
        const fileContent = pdfData.text;
        const maxLen = 50_000;
        const truncated = fileContent.length > maxLen ? fileContent.slice(0, maxLen) + '\n...(内容过长，已截断)' : fileContent;
        fileContentParts.push(`[文件: ${fileName}]\n\`\`\`\n${truncated}\n\`\`\``);
        log?.info?.(`[DingTalk][File] PDF 文档已提取文本: ${fileName}, size=${fileContent.length}`);
      } catch (err: any) {
        log?.error?.(`[DingTalk][File] PDF 文档文本提取失败: ${err.message}`);
        fileContentParts.push(`[文件已保存: ${localPath}，但提取文本失败]`);
      }
    } else {
      fileContentParts.push(`[文件已保存: ${localPath}，请基于文件名和上下文回答]`);
      log?.info?.(`[DingTalk][File] 文件已保存: ${fileName} -> ${localPath}`);
    }
  }

  if (fileContentParts.length > 0) {
    const fileText = fileContentParts.join('\n\n');
    userContent = userContent ? `${userContent}\n\n${fileText}` : fileText;
  }

  if (!userContent && imageLocalPaths.length === 0) return;

  // 获取 oapi token
  // ===== 使用 SDK 的 dispatchReplyFromConfig =====
  try {
    console.log(`[DingTalk][${accountId}] ========== 开始 SDK 处理 ==========`);
    const core = getDingtalkRuntime();
    console.log(`[DingTalk][${accountId}] core 获取成功`);
    
    // 构建消息体（添加图片）
    let finalContent = userContent;
    if (imageLocalPaths.length > 0) {
      const imageMarkdown = imageLocalPaths.map(p => `![image](file://${p})`).join('\n');
      finalContent = finalContent ? `${finalContent}\n\n${imageMarkdown}` : imageMarkdown;
    }
    console.log(`[DingTalk][${accountId}] finalContent: ${finalContent.substring(0, 100)}...`);

    // 构建 envelope 格式的消息
    console.log(`[DingTalk][${accountId}] 开始构建 envelope...`);
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    console.log(`[DingTalk][${accountId}] envelopeOptions:`, JSON.stringify(envelopeOptions));
    const envelopeFrom = isDirect ? senderId : `${data.conversationId}:${senderId}`;
    console.log(`[DingTalk][${accountId}] envelopeFrom: ${envelopeFrom}`);
    
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "DingTalk",
      from: envelopeFrom,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: finalContent,
    });
    console.log(`[DingTalk][${accountId}] body 构建完成: ${body.substring(0, 100)}...`);

    // ✅ 【关键修复】手动实现路由匹配（支持通配符 *）
    console.log(`[DingTalk][${accountId}] 开始解析 agent 路由...`);
    const chatType = isDirect ? "direct" : "group";
    const peerId = isDirect ? senderId : data.conversationId;
    
    console.log(`[DingTalk][${accountId}] 路由参数: channel=dingtalk-connector, accountId=${accountId}, peer={kind:${chatType}, id:${peerId}}`);
    
    // 手动匹配 bindings（支持通配符 *）
    let matchedAgentId: string | null = null;
    let matchedBy = 'default';
    
    if (cfg.bindings && cfg.bindings.length > 0) {
      for (const binding of cfg.bindings) {
        const match = binding.match;
        
        // 检查 channel
        if (match.channel && match.channel !== "dingtalk-connector") {
          continue;
        }
        
        // 检查 accountId
        if (match.accountId && match.accountId !== accountId) {
          continue;
        }
        
        // 检查 peer
        if (match.peer) {
          // 检查 peer.kind
          if (match.peer.kind && match.peer.kind !== chatType) {
            continue;
          }
          
          // 检查 peer.id（支持通配符 *）
          if (match.peer.id && match.peer.id !== '*' && match.peer.id !== peerId) {
            continue;
          }
        }
        
        // 匹配成功
        matchedAgentId = binding.agentId;
        matchedBy = 'binding';
        console.log(`[DingTalk][${accountId}] ✅ 匹配成功: agentId=${matchedAgentId}, binding=${JSON.stringify(binding.match)}`);
        break;
      }
    }
    
    // 如果没有匹配到，使用默认 agent
    if (!matchedAgentId) {
      matchedAgentId = cfg.defaultAgent || 'ding-bot1';
      console.log(`[DingTalk][${accountId}] ⚠️ 未匹配到 binding，使用默认 agent: ${matchedAgentId}`);
    }
    
    // 构建 sessionKey
    const sessionKey = `agent:${matchedAgentId}:dingtalk-connector:${chatType}:${peerId}`;
    console.log(`[DingTalk][${accountId}] 路由解析完成: agentId=${matchedAgentId}, sessionKey=${sessionKey}, matchedBy=${matchedBy}`);
    
    // 构建 inbound context，使用解析后的 sessionKey
    console.log(`[DingTalk][${accountId}] 开始构建 inbound context...`);
    
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: finalContent,
      RawBody: userContent,
      CommandBody: userContent,
      From: senderId,
      To: accountId,
      SessionKey: sessionKey,  // ✅ 使用手动匹配的 sessionKey
      AccountId: accountId,
      ChatType: chatType,
      GroupSubject: isDirect ? undefined : data.conversationId,
      SenderName: senderId,
      SenderId: senderId,
      Provider: "dingtalk" as const,
      Surface: "dingtalk" as const,
      MessageSid: data.msgId,
      Timestamp: Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: "dingtalk" as const,
      OriginatingTo: accountId,
    });
    console.log(`[DingTalk][${accountId}] ctxPayload 构建完成, SessionKey: ${ctxPayload.SessionKey}`);

    // 创建 reply dispatcher，使用解析后的 agentId
    console.log(`[DingTalk][${accountId}] 开始创建 reply dispatcher...`);
    
    const { dispatcher, replyOptions, markDispatchIdle } = createDingtalkReplyDispatcher({
      cfg,
      agentId: matchedAgentId,  // ✅ 使用手动匹配的 agentId
      runtime: runtime as RuntimeEnv,
      conversationId: data.conversationId,
      senderId,
      isDirect,
      accountId,
      messageCreateTimeMs: Date.now(),
      sessionWebhook: data.sessionWebhook,
    });
    console.log(`[DingTalk][${accountId}] reply dispatcher 创建完成，使用 agentId: ${matchedAgentId}`);
    console.log(`[DingTalk][${accountId}] replyOptions keys:`, Object.keys(replyOptions));
    console.log(`[DingTalk][${accountId}] replyOptions.onModelSelected:`, typeof replyOptions.onModelSelected);
    console.log(`[DingTalk][${accountId}] replyOptions.onPartialReply:`, typeof replyOptions.onPartialReply);

    console.log(`[DingTalk][${accountId}] 开始 SDK dispatch: session=${ctxPayload.SessionKey}`);

    // 使用 SDK 的 dispatchReplyFromConfig
    console.log(`[DingTalk][${accountId}] 调用 withReplyDispatcher...`);
    const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        console.log(`[DingTalk][${accountId}] onSettled 被调用`);
        markDispatchIdle();
      },
      run: () => {
        console.log(`[DingTalk][${accountId}] run 被调用，开始 dispatchReplyFromConfig...`);
        return core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        });
      },
    });

    console.log(`[DingTalk][${accountId}] SDK dispatch 完成: queuedFinal=${queuedFinal}, replies=${counts.final}`);

  } catch (err: any) {
    log?.error?.(`[DingTalk] SDK dispatch 失败: ${err.message}`);
    
    // 降级：发送错误消息
    try {
      const token = await getAccessToken(config);
      const body: any = { 
        msgtype: 'text', 
        text: { content: `抱歉，处理请求时出错: ${err.message}` } 
      };
      if (!isDirect) body.at = { atUserIds: [senderId], isAtAll: false };
      
      await axios.post(sessionWebhook, body, {
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      });
    } catch (fallbackErr: any) {
      log?.error?.(`[DingTalk] 错误消息发送也失败: ${fallbackErr.message}`);
    }
  }
}

// handleDingTalkMessage 已在函数定义处直接导出
