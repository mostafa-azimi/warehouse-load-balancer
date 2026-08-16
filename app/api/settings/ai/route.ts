import { NextRequest, NextResponse } from "next/server";
import {
  deleteAiSettings,
  getAiSettingsStatus,
  saveAiSettings,
  verifyAiAdminPassword,
  type AiProvider,
} from "@/lib/ai-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getAiSettingsStatus());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load AI settings" },
      { status: 502 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      adminPassword?: string;
      provider?: AiProvider;
      model?: string;
      apiKey?: string;
    };
    if (!verifyAiAdminPassword(body.adminPassword ?? "")) {
      return NextResponse.json({ error: "Invalid settings administrator password" }, { status: 401 });
    }
    if (body.provider !== "openai" && body.provider !== "anthropic") {
      return NextResponse.json({ error: "Choose OpenAI or Anthropic" }, { status: 400 });
    }
    return NextResponse.json(
      await saveAiSettings({
        provider: body.provider,
        model: body.model ?? "",
        apiKey: body.apiKey,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save AI settings" },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { adminPassword?: string };
    if (!verifyAiAdminPassword(body.adminPassword ?? "")) {
      return NextResponse.json({ error: "Invalid settings administrator password" }, { status: 401 });
    }
    await deleteAiSettings();
    return NextResponse.json({ configured: false });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to remove AI settings" },
      { status: 400 },
    );
  }
}
