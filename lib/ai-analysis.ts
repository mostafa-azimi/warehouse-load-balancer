import type { AnalysisResult } from "./types";
import type { AiProvider } from "./ai-settings";

export type AiAnalysis = {
  generatedAt: string;
  provider: AiProvider;
  model: string;
  summary: string;
  priorities: Array<{
    sku: string;
    action: string;
    reason: string;
    risk: "low" | "medium" | "high";
  }>;
  questions: string[];
  cautions: string[];
};

function analysisPayload(analysis: AnalysisResult) {
  return {
    client: analysis.client,
    lookbackDays: analysis.lookbackDays,
    dataAsOf: analysis.dataAsOf,
    metrics: analysis.metrics,
    excludedShipments: analysis.exclusions ?? [],
    recommendations: analysis.recommendations.slice(0, 50).map((item) => ({
      sku: item.sku,
      productName: item.productName,
      route: `${item.fromWarehouse.code} to ${item.toWarehouse.code}`,
      units: item.quantity,
      availableBefore: {
        source: item.fromAvailable,
        destination: item.toAvailable,
      },
      historicalDemand: {
        source: item.fromDemand,
        destination: item.toDemand,
      },
      recentDemand14Days: item.recentDemand14Days,
      recencyStatus: item.recencyStatus,
      projectedCoverageDays: {
        source: item.projectedFromDays,
        destination: item.projectedToDays,
      },
      deterministicConfidence: item.confidence,
      reason: item.reason,
      recencyReason: item.recencyReason,
      kitSources: item.kitSources,
    })),
  };
}

const systemPrompt = `You are an inventory analyst for a 3PL. Review deterministic warehouse-balancing output and identify operational risks or questions; do not recalculate or invent inventory. FBA, wholesale, and internal-transfer shipments listed as excluded must not influence recommendations. Treat no demand in the last 14 days as a strong warning that packaging, inserts, or product usage may have changed. Prefer a short prioritized answer. Return valid JSON only with this exact shape: {"summary":string,"priorities":[{"sku":string,"action":string,"reason":string,"risk":"low"|"medium"|"high"}],"questions":string[],"cautions":string[]}. Include no more than 8 priorities, 6 questions, and 6 cautions.`;

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI provider did not return JSON");
  return JSON.parse(cleaned.slice(start, end + 1)) as Omit<AiAnalysis, "generatedAt" | "provider" | "model">;
}

function openAiText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (typeof block.text === "string") return block.text;
    }
  }
  throw new Error("OpenAI returned no analysis text");
}

async function analyzeWithOpenAi(apiKey: string, model: string, analysis: AnalysisResult) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 1800,
      instructions: systemPrompt,
      input: JSON.stringify(analysisPayload(analysis)),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(typeof error?.message === "string" ? error.message : "OpenAI analysis failed");
  }
  return parseJson(openAiText(payload));
}

async function analyzeWithAnthropic(apiKey: string, model: string, analysis: AnalysisResult) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1800,
      system: systemPrompt,
      messages: [{ role: "user", content: JSON.stringify(analysisPayload(analysis)) }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(typeof error?.message === "string" ? error.message : "Anthropic analysis failed");
  }
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = (content as Array<Record<string, unknown>>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return parseJson(text);
}

export async function runAiAnalysis(input: {
  provider: AiProvider;
  model: string;
  apiKey: string;
  analysis: AnalysisResult;
}): Promise<AiAnalysis> {
  const result = input.provider === "openai"
    ? await analyzeWithOpenAi(input.apiKey, input.model, input.analysis)
    : await analyzeWithAnthropic(input.apiKey, input.model, input.analysis);
  const priorities = Array.isArray(result.priorities)
    ? result.priorities.slice(0, 8).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        const risk: AiAnalysis["priorities"][number]["risk"] = value.risk === "low" || value.risk === "medium" || value.risk === "high"
          ? value.risk
          : "medium";
        return [{
          sku: String(value.sku ?? "Review"),
          action: String(value.action ?? "Review this recommendation"),
          reason: String(value.reason ?? "The provider did not supply a reason."),
          risk,
        }];
      })
    : [];
  return {
    generatedAt: new Date().toISOString(),
    provider: input.provider,
    model: input.model,
    summary: String(result.summary ?? ""),
    priorities,
    questions: Array.isArray(result.questions) ? result.questions.map(String).slice(0, 6) : [],
    cautions: Array.isArray(result.cautions) ? result.cautions.map(String).slice(0, 6) : [],
  };
}
