import { NextResponse } from "next/server";
import { getProviderUsage, redeemProviderUsageReset } from "@/lib/provider-usage";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider")?.trim() || undefined;
    const modelId = searchParams.get("model")?.trim() || undefined;
    if (provider && provider.length > 128) {
      return NextResponse.json({ error: "provider is too long" }, { status: 400 });
    }
    if (modelId && modelId.length > 256) {
      return NextResponse.json({ error: "model is too long" }, { status: 400 });
    }
    const snapshot = await getProviderUsage({ provider, modelId });
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; targetId?: unknown };
    if (body.action !== "redeem-reset") {
      return NextResponse.json({ error: "unsupported action", code: "unsupported_action" }, { status: 400 });
    }
    if (
      typeof body.targetId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.targetId)
    ) {
      return NextResponse.json({ error: "invalid reset target", code: "invalid_target" }, { status: 400 });
    }

    const result = await redeemProviderUsageReset(body.targetId);
    const status = result.code === "stale_target" ? 409 : result.code === "in_progress" ? 409 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "reset_failed",
      },
      { status: 502 },
    );
  }
}
