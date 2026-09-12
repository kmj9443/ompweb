import { NextResponse } from "next/server";
import { getProviderUsage, invalidateProviderUsageCache, redeemProviderUsageReset } from "@/lib/provider-usage";

export const dynamic = "force-dynamic";

const IDENTIFIER_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const RESET_TARGET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readIdentifier(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return IDENTIFIER_RE.test(trimmed) ? trimmed : undefined;
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const rawProvider = searchParams.get("provider");
  const rawModel = searchParams.get("model");
  const provider = readIdentifier(rawProvider);
  const modelId = readIdentifier(rawModel);

  if ((rawProvider !== null && !provider) || (rawModel !== null && !modelId)) {
    return NextResponse.json(
      { error: "Invalid provider or model identifier", code: "invalid_usage_query" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await getProviderUsage({ provider, modelId }));
  } catch {
    return NextResponse.json(
      { error: "Provider usage is currently unavailable", code: "provider_usage_unavailable" },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  let body: { action?: unknown; targetId?: unknown };
  try {
    body = await request.json() as { action?: unknown; targetId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }

  if (body.action !== "redeem-reset") {
    return NextResponse.json({ error: "Unsupported provider usage action", code: "unsupported_action" }, { status: 400 });
  }
  if (typeof body.targetId !== "string" || !RESET_TARGET_RE.test(body.targetId)) {
    return NextResponse.json({ error: "Invalid reset target", code: "invalid_target" }, { status: 400 });
  }

  try {
    const result = await redeemProviderUsageReset(body.targetId);
    const status = result.code === "stale_target" || result.code === "in_progress" ? 409 : 200;
    return NextResponse.json(result, { status });
  } catch {
    return NextResponse.json(
      { error: "Saved reset could not be applied", code: "reset_failed" },
      { status: 502 },
    );
  } finally {
    invalidateProviderUsageCache();
  }
}
