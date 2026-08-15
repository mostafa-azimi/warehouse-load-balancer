import { Redis } from "@upstash/redis";

export function redisConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export function getRedis() {
  if (!redisConfigured()) {
    throw new Error("The Upstash Redis integration is not configured");
  }
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}
