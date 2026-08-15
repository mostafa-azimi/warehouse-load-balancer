import { NextRequest, NextResponse } from "next/server";
import { buildAnalysis } from "@/lib/balancing";
import { demoClients, getDemoInput } from "@/lib/demo-data";
import { getLiveAnalysisInput, isLiveMode, listLiveClients } from "@/lib/shiphero";

const validLookbacks = new Set([60, 90, 120]);

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { clientId?: string; lookbackDays?: number };
    if (!body.clientId || !validLookbacks.has(body.lookbackDays ?? 0)) {
      return NextResponse.json({ error: "Choose a client and a 60, 90, or 120 day window." }, { status: 400 });
    }
    const lookbackDays = body.lookbackDays as 60 | 90 | 120;
    let input;
    if (isLiveMode()) {
      const clients = await listLiveClients();
      const client = clients.find((item) => item.id === body.clientId);
      if (!client) return NextResponse.json({ error: "Client is not on the eligible account allowlist." }, { status: 403 });
      input = await getLiveAnalysisInput(client, lookbackDays);
    } else {
      if (!demoClients.some((item) => item.id === body.clientId)) {
        return NextResponse.json({ error: "Unknown demo client." }, { status: 404 });
      }
      input = getDemoInput(body.clientId, lookbackDays);
    }
    return NextResponse.json(buildAnalysis(input));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 502 },
    );
  }
}
