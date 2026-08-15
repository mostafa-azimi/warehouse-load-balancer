import { NextResponse } from "next/server";
import { demoClients } from "@/lib/demo-data";
import { isLiveMode, listLiveClients } from "@/lib/shiphero";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const clients = isLiveMode() ? await listLiveClients() : demoClients;
    return NextResponse.json({ clients, mode: isLiveMode() ? "live" : "demo" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load clients" },
      { status: 502 },
    );
  }
}
