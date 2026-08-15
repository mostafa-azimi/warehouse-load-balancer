import { Redis } from "@upstash/redis";

const TOKEN_KEY = "warehouse-load-balancer:shiphero:oauth";
const LOCK_KEY = `${TOKEN_KEY}:refresh-lock`;
const TOKEN_ENDPOINT = "https://login.shiphero.com/oauth/token";
const REFRESH_INTERVAL_MS = 25 * 24 * 60 * 60 * 1_000;
const EXPIRY_SAFETY_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;

type TokenState = {
  accessToken: string;
  refreshToken: string;
  issuedAt: number;
  expiresAt: number;
  updatedAt: string;
};

export type RefreshResult = {
  refreshed: boolean;
  nextRefreshAt: string;
  expiresAt: string;
};

function redisConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function redis() {
  if (!redisConfigured()) {
    throw new Error("The Upstash Redis integration is not configured");
  }
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

function jwtTimes(token: string) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    ) as { iat?: number; exp?: number };
    return {
      issuedAt: payload.iat ? payload.iat * 1_000 : Date.now(),
      expiresAt: payload.exp ? payload.exp * 1_000 : Date.now(),
    };
  } catch {
    throw new Error("ShipHero returned an access token without valid JWT dates");
  }
}

function bootstrapTokenState(): TokenState {
  const accessToken = process.env.SHIPHERO_ACCESS_TOKEN;
  const refreshToken = process.env.SHIPHERO_REFRESH_TOKEN;
  if (!accessToken || !refreshToken) {
    throw new Error("ShipHero access and refresh tokens are not configured");
  }
  const times = jwtTimes(accessToken);
  return {
    accessToken,
    refreshToken,
    ...times,
    updatedAt: new Date().toISOString(),
  };
}

async function getTokenState() {
  if (!redisConfigured()) return bootstrapTokenState();
  const client = redis();
  const stored = await client.get<TokenState>(TOKEN_KEY);
  if (stored) return stored;
  const bootstrap = bootstrapTokenState();
  await client.set(TOKEN_KEY, bootstrap, { nx: true });
  return (await client.get<TokenState>(TOKEN_KEY)) ?? bootstrap;
}

function refreshDue(state: TokenState) {
  const now = Date.now();
  return (
    now >= state.issuedAt + REFRESH_INTERVAL_MS ||
    state.expiresAt - now <= EXPIRY_SAFETY_WINDOW_MS
  );
}

function result(state: TokenState, refreshed: boolean): RefreshResult {
  return {
    refreshed,
    nextRefreshAt: new Date(
      Math.min(
        state.issuedAt + REFRESH_INTERVAL_MS,
        state.expiresAt - EXPIRY_SAFETY_WINDOW_MS,
      ),
    ).toISOString(),
    expiresAt: new Date(state.expiresAt).toISOString(),
  };
}

async function exchangeRefreshToken(state: TokenState) {
  const clientId = process.env.SHIPHERO_CLIENT_ID;
  if (!clientId) throw new Error("SHIPHERO_CLIENT_ID is not configured");
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: state.refreshToken,
    }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`ShipHero token refresh failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!payload.access_token) {
    throw new Error("ShipHero token refresh returned no access token");
  }
  const times = jwtTimes(payload.access_token);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || state.refreshToken,
    ...times,
    updatedAt: new Date().toISOString(),
  } satisfies TokenState;
}

export async function refreshShipHeroTokens(force = false): Promise<RefreshResult> {
  if (!redisConfigured()) {
    throw new Error("Redis is required before automatic token refresh can run");
  }
  const client = redis();
  const lockId = crypto.randomUUID();
  const lock = await client.set(LOCK_KEY, lockId, { nx: true, ex: 60 });
  if (!lock) {
    const state = await getTokenState();
    return result(state, false);
  }

  try {
    const state = await getTokenState();
    if (!force && !refreshDue(state)) return result(state, false);
    const refreshedState = await exchangeRefreshToken(state);
    await client.set(TOKEN_KEY, refreshedState);
    return result(refreshedState, true);
  } finally {
    if ((await client.get<string>(LOCK_KEY)) === lockId) {
      await client.del(LOCK_KEY);
    }
  }
}

export async function getShipHeroAccessToken() {
  const state = await getTokenState();
  if (!redisConfigured() || !refreshDue(state)) return state.accessToken;
  try {
    await refreshShipHeroTokens();
    return (await getTokenState()).accessToken;
  } catch (error) {
    if (state.expiresAt > Date.now() + 5 * 60 * 1_000) return state.accessToken;
    throw error;
  }
}
