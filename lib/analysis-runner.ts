import { buildAnalysis } from "./balancing";
import { getRedis, redisConfigured } from "./redis";
import {
  clearLiveAnalysisProgress,
  getLiveAnalysisProgress,
  getLiveAnalysisInput,
  ShipHeroBusyError,
} from "./shiphero";
import type { AnalysisResult, ClientAccount } from "./types";

const CACHE_SECONDS = 10 * 60;
const LOCK_SECONDS = 5 * 60;
const WAIT_LIMIT_MS = 15_000;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function keys(client: ClientAccount, lookbackDays: 60 | 90 | 120) {
  const suffix = `${client.id}:${lookbackDays}`;
  return {
    cache: `warehouse-load-balancer:analysis:v4:${suffix}`,
    lock: `warehouse-load-balancer:analysis-lock:v1:${suffix}`,
  };
}

async function calculate(
  client: ClientAccount,
  lookbackDays: 60 | 90 | 120,
) {
  return buildAnalysis(await getLiveAnalysisInput(client, lookbackDays));
}

export async function runLiveAnalysis(
  client: ClientAccount,
  lookbackDays: 60 | 90 | 120,
): Promise<AnalysisResult> {
  if (!redisConfigured()) return calculate(client, lookbackDays);

  const redis = getRedis();
  const key = keys(client, lookbackDays);
  const cached = await redis.get<AnalysisResult>(key.cache);
  if (cached) return cached;

  const lockId = crypto.randomUUID();
  const deadline = Date.now() + WAIT_LIMIT_MS;

  while (Date.now() < deadline) {
    const lock = await redis.set(key.lock, lockId, {
      nx: true,
      ex: LOCK_SECONDS,
    });

    if (lock) {
      try {
        const result = await calculate(client, lookbackDays);
        await redis.set(key.cache, result, { ex: CACHE_SECONDS });
        await clearLiveAnalysisProgress(client, lookbackDays);
        return result;
      } catch (error) {
        if (error instanceof ShipHeroBusyError) {
          error.progress = await getLiveAnalysisProgress(client, lookbackDays);
        }
        throw error;
      } finally {
        if ((await redis.get<string>(key.lock)) === lockId) {
          await redis.del(key.lock);
        }
      }
    }

    await sleep(1_500);
    const sharedResult = await redis.get<AnalysisResult>(key.cache);
    if (sharedResult) return sharedResult;
  }

  const error = new ShipHeroBusyError(
    "Another request is advancing this analysis. This page will continue automatically.",
    1_500,
  );
  error.progress = await getLiveAnalysisProgress(client, lookbackDays);
  throw error;
}
