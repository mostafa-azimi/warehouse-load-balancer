import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getRedis, redisConfigured } from "./redis";

export type AiProvider = "openai" | "anthropic";

type StoredAiSettings = {
  provider: AiProvider;
  model: string;
  encryptedApiKey: string;
  keySuffix: string;
  updatedAt: string;
};

export type AiSettingsStatus = {
  available: boolean;
  configured: boolean;
  provider: AiProvider | null;
  model: string | null;
  maskedApiKey: string | null;
  updatedAt: string | null;
};

const SETTINGS_KEY = "warehouse-load-balancer:ai-settings:v1";

function encryptionKey() {
  const secret = process.env.AI_SETTINGS_ENCRYPTION_KEY;
  if (!secret) throw new Error("AI settings encryption is not configured");
  return createHash("sha256").update(secret).digest();
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Stored AI settings are invalid");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function aiSettingsAvailable() {
  return Boolean(
    redisConfigured() &&
      process.env.AI_SETTINGS_ENCRYPTION_KEY &&
      process.env.AI_SETTINGS_ADMIN_PASSWORD,
  );
}

export function verifyAiAdminPassword(candidate: string) {
  const expected = process.env.AI_SETTINGS_ADMIN_PASSWORD ?? "";
  const expectedHash = createHash("sha256").update(expected).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return Boolean(expected) && timingSafeEqual(expectedHash, candidateHash);
}

async function readStoredSettings() {
  if (!redisConfigured()) return null;
  return getRedis().get<StoredAiSettings>(SETTINGS_KEY);
}

export async function getAiSettingsStatus(): Promise<AiSettingsStatus> {
  if (!aiSettingsAvailable()) {
    return {
      available: false,
      configured: false,
      provider: null,
      model: null,
      maskedApiKey: null,
      updatedAt: null,
    };
  }
  const settings = await readStoredSettings();
  return {
    available: true,
    configured: Boolean(settings),
    provider: settings?.provider ?? null,
    model: settings?.model ?? null,
    maskedApiKey: settings ? `••••${settings.keySuffix}` : null,
    updatedAt: settings?.updatedAt ?? null,
  };
}

export async function saveAiSettings(input: {
  provider: AiProvider;
  model: string;
  apiKey?: string;
}) {
  if (!aiSettingsAvailable()) throw new Error("AI settings are not available");
  const current = await readStoredSettings();
  const apiKey = input.apiKey?.trim();
  if (!apiKey && !current) throw new Error("Enter an API key");
  if (!apiKey && current && current.provider !== input.provider) {
    throw new Error("Enter a new API key when changing providers");
  }
  if (!input.model.trim() || input.model.length > 100) throw new Error("Enter a valid model ID");
  if (apiKey && apiKey.length < 20) throw new Error("The API key appears incomplete");

  const encryptedApiKey = apiKey ? encrypt(apiKey) : current!.encryptedApiKey;
  const keySuffix = apiKey ? apiKey.slice(-4) : current!.keySuffix;
  const settings: StoredAiSettings = {
    provider: input.provider,
    model: input.model.trim(),
    encryptedApiKey,
    keySuffix,
    updatedAt: new Date().toISOString(),
  };
  await getRedis().set(SETTINGS_KEY, settings);
  return getAiSettingsStatus();
}

export async function deleteAiSettings() {
  if (!redisConfigured()) return;
  await getRedis().del(SETTINGS_KEY);
}

export async function getAiSettings() {
  if (!aiSettingsAvailable()) throw new Error("AI settings are not available");
  const settings = await readStoredSettings();
  if (!settings) throw new Error("Configure an AI provider in Settings first");
  return {
    provider: settings.provider,
    model: settings.model,
    apiKey: decrypt(settings.encryptedApiKey),
  };
}
