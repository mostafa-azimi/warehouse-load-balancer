import { NextResponse } from "next/server";
import { demoClients } from "@/lib/demo-data";
import { getLiveClientAccessStatus, isLiveMode } from "@/lib/shiphero";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!isLiveMode()) {
      return NextResponse.json({ clients: demoClients, mode: "demo" });
    }
    const status = await getLiveClientAccessStatus();
    return NextResponse.json({ ...status, mode: "live" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load clients" },
      { status: 502 },
    );
  }
}
