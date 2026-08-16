import { NextRequest, NextResponse } from "next/server";
import { getAiSettings, verifyAiAdminPassword } from "@/lib/ai-settings";
import { runAiAnalysis } from "@/lib/ai-analysis";
import { runLiveAnalysis } from "@/lib/analysis-runner";
import { buildAnalysis } from "@/lib/balancing";
import { demoClients, getDemoInput } from "@/lib/demo-data";
import { getRedis, redisConfigured } from "@/lib/redis";
import { isLiveMode, listLiveClients } from "@/lib/shiphero";

export const maxDuration = 120;

const validLookbacks = new Set([60, 90, 120]);

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      adminPassword?: string;
      clientId?: string;
      lookbackDays?: number;
    };
    if (!verifyAiAdminPassword(body.adminPassword ?? "")) {
      return NextResponse.json({ error: "Invalid settings administrator password" }, { status: 401 });
    }
    if (!body.clientId || !validLookbacks.has(body.lookbackDays ?? 0)) {
      return NextResponse.json({ error: "Choose a client and analysis window" }, { status: 400 });
    }
    const lookbackDays = body.lookbackDays as 60 | 90 | 120;
    const rateKey = `warehouse-load-balancer:ai-rate:v1:${body.clientId}`;
    if (redisConfigured()) {
      const acquired = await getRedis().set(rateKey, "1", { nx: true, ex: 30 });
      if (!acquired) {
        return NextResponse.json({ error: "Wait 30 seconds before running AI analysis again" }, { status: 429 });
      }
    }

    const analysis = isLiveMode()
      ? await (async () => {
          const client = (await listLiveClients()).find((item) => item.id === body.clientId);
          if (!client) throw new Error("Client is not on the eligible account allowlist");
          return runLiveAnalysis(client, lookbackDays);
        })()
      : buildAnalysis(getDemoInput(
          demoClients.some((item) => item.id === body.clientId) ? body.clientId : demoClients[0].id,
          lookbackDays,
        ));
    const settings = await getAiSettings();
    return NextResponse.json(await runAiAnalysis({ ...settings, analysis }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AI analysis failed" },
      { status: 502 },
    );
  }
}
