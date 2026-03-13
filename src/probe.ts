import { raceWithTimeoutAndAbort } from "./async.ts";
import type { DingtalkProbeResult } from "./types.ts";

/** Cache probe results to reduce repeated health-check calls. */
const probeCache = new Map<string, { result: DingtalkProbeResult; expiresAt: number }>();
const PROBE_SUCCESS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROBE_ERROR_TTL_MS = 60 * 1000; // 1 minute
const MAX_PROBE_CACHE_SIZE = 64;
export const DINGTALK_PROBE_REQUEST_TIMEOUT_MS = 10_000;
export type ProbeDingtalkOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

type DingtalkBotInfoResponse = {
  errcode?: number;
  errmsg?: string;
  nick?: string;
  unionid?: string;
};

function setCachedProbeResult(
  cacheKey: string,
  result: DingtalkProbeResult,
  ttlMs: number,
): DingtalkProbeResult {
  probeCache.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) {
      probeCache.delete(oldest);
    }
  }
  return result;
}

export async function probeDingtalk(
  creds?: { clientId: string; clientSecret: string; accountId?: string },
  options: ProbeDingtalkOptions = {},
): Promise<DingtalkProbeResult> {
  if (!creds?.clientId || !creds?.clientSecret) {
    return {
      ok: false,
      error: "missing credentials (clientId, clientSecret)",
    };
  }
  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      clientId: creds.clientId,
      error: "probe aborted",
    };
  }

  const timeoutMs = options.timeoutMs ?? DINGTALK_PROBE_REQUEST_TIMEOUT_MS;

  // Return cached result if still valid.
  const cacheKey = creds.accountId ?? `${creds.clientId}:${creds.clientSecret.slice(0, 8)}`;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    // Get access token
    const tokenResponse = await raceWithTimeoutAndAbort(
      fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appKey: creds.clientId,
          appSecret: creds.clientSecret,
        }),
      }),
      { timeoutMs, abortSignal: options.abortSignal },
    );

    if (tokenResponse.status === "aborted") {
      return {
        ok: false,
        clientId: creds.clientId,
        error: "probe aborted",
      };
    }
    if (tokenResponse.status === "timeout") {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          clientId: creds.clientId,
          error: `probe timed out after ${timeoutMs}ms`,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const tokenData = await tokenResponse.value.json() as { accessToken?: string };
    if (!tokenData.accessToken) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          clientId: creds.clientId,
          error: "failed to get access token",
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    // Get bot info
    const botResponse = await raceWithTimeoutAndAbort(
      fetch(`https://api.dingtalk.com/v1.0/contact/users/me`, {
        method: "GET",
        headers: {
          "x-acs-dingtalk-access-token": tokenData.accessToken,
          "Content-Type": "application/json",
        },
      }),
      { timeoutMs, abortSignal: options.abortSignal },
    );

    if (botResponse.status === "aborted") {
      return {
        ok: false,
        clientId: creds.clientId,
        error: "probe aborted",
      };
    }
    if (botResponse.status === "timeout") {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          clientId: creds.clientId,
          error: `probe timed out after ${timeoutMs}ms`,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    const botData = await botResponse.value.json() as DingtalkBotInfoResponse;
    if (botData.errcode && botData.errcode !== 0) {
      return setCachedProbeResult(
        cacheKey,
        {
          ok: false,
          clientId: creds.clientId,
          error: `API error: ${botData.errmsg || `code ${botData.errcode}`}`,
        },
        PROBE_ERROR_TTL_MS,
      );
    }

    return setCachedProbeResult(
      cacheKey,
      {
        ok: true,
        clientId: creds.clientId,
        botName: botData.nick,
      },
      PROBE_SUCCESS_TTL_MS,
    );
  } catch (err) {
    return setCachedProbeResult(
      cacheKey,
      {
        ok: false,
        clientId: creds.clientId,
        error: err instanceof Error ? err.message : String(err),
      },
      PROBE_ERROR_TTL_MS,
    );
  }
}

/** Clear the probe cache (for testing). */
export function clearProbeCache(): void {
  probeCache.clear();
}
