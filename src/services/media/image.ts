/**
 * 图片处理模块
 * 支持图片上传、本地路径处理
 */

// 本地类型定义
interface Logger {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  [key: string]: any;
}

import {
  LOCAL_IMAGE_RE,
  BARE_IMAGE_PATH_RE,
  toLocalPath,
  uploadMediaToDingTalk,
} from './common.ts';

/**
 * 扫描内容中的本地图片路径，上传到钉钉并替换为 media_id
 */
export async function processLocalImages(
  content: string,
  oapiToken: string | null,
  log?: Logger,
): Promise<string> {
  if (!oapiToken) {
    log?.warn?.(`[DingTalk][Media] 无 oapiToken，跳过图片后处理`);
    return content;
  }

  let result = content;

  // 第一步：匹配 markdown 图片语法 ![alt](path)
  const mdMatches = [...content.matchAll(LOCAL_IMAGE_RE)];
  if (mdMatches.length > 0) {
    log?.info?.(`[DingTalk][Media] 检测到 ${mdMatches.length} 个 markdown 图片，开始上传...`);
    for (const match of mdMatches) {
      const [fullMatch, alt, rawPath] = match;
      const cleanPath = rawPath.replace(/\\ /g, ' ');
      const uploadResult = await uploadMediaToDingTalk(cleanPath, 'image', oapiToken, 20 * 1024 * 1024, log);
      if (uploadResult) {
        result = result.replace(fullMatch, `![${alt}](${uploadResult})`);
      }
    }
  }

  // 第二步：匹配纯文本中的本地图片路径
  const bareMatches = [...result.matchAll(BARE_IMAGE_PATH_RE)];
  const newBareMatches = bareMatches.filter((m) => {
    if (m.index === undefined) return false;
    const idx = m.index;
    const before = result.slice(Math.max(0, idx - 10), idx);
    return !before.includes('](');
  });

  if (newBareMatches.length > 0) {
    log?.info?.(`[DingTalk][Media] 检测到 ${newBareMatches.length} 个纯文本图片路径，开始上传...`);
    for (const match of newBareMatches.reverse()) {
      const [fullMatch, rawPath] = match;
      log?.info?.(`[DingTalk][Media] 纯文本图片："${fullMatch}" -> path="${rawPath}"`);
      const uploadResult = await uploadMediaToDingTalk(rawPath, 'image', oapiToken, 20 * 1024 * 1024, log);
      if (uploadResult) {
        const replacement = `![](${uploadResult})`;
        result = result.slice(0, match.index!) + result.slice(match.index!).replace(fullMatch, replacement);
        log?.info?.(`[DingTalk][Media] 替换纯文本路径为图片：${replacement}`);
      }
    }
  }

  return result;
}
