import { randomUUID } from "crypto";
import { homedir } from "os";
import { RpcProcess } from "@/lib/omp/rpc-process";
import { isRecord } from "@/lib/type-guards";

const RESET_TARGET_TTL_MS = 6 * 60_000;
const RESET_COMMAND_TIMEOUT_MS = 60_000;
const UTILITY_EXTRA_ARGS = ["--no-session", "--no-skills", "--no-lsp"];

type ResetTarget = {
  provider: string;
  accountId?: string;
  email?: string;
  expiresAt: number;
};

type ResetState = {
  generation: number;
  targets: Map<string, ResetTarget>;
  inFlightAccounts: Set<string>;
};

export type ProviderUsageResetResultCode =
  | "reset"
  | "already_redeemed"
  | "no_credit"
  | "credit_list_failed"
  | "nothing_to_reset"
  | "no_account"
  | "account_unavailable"
  | "stale_target"
  | "in_progress"
  | "unknown";

export interface ProviderUsageResetResult {
  ok: boolean;
  code: ProviderUsageResetResultCode;
}

declare global {
  var __ompProviderUsageResetState: ResetState | undefined;
}

function state(): ResetState {
  globalThis.__ompProviderUsageResetState ??= {
    generation: 0,
    targets: new Map(),
    inFlightAccounts: new Set(),
  };
  return globalThis.__ompProviderUsageResetState;
}

export function getProviderUsageResetGeneration(): number {
  return state().generation;
}

export function invalidateProviderUsageResetTargets(): void {
  const current = state();
  current.generation += 1;
  current.targets.clear();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildRedactionMap(values: Iterable<string>): Map<string, string> {
  const unique = [...new Set(values)];
  const map = new Map<string, string>();
  const byAnchor = new Map<string, string[]>();

  for (const value of unique) {
    const anchor = value.slice(0, 2);
    const peers = byAnchor.get(anchor) ?? [];
    peers.push(value);
    byAnchor.set(anchor, peers);
  }

  for (const value of unique) {
    const anchor = value.slice(0, 2);
    const peers = (byAnchor.get(anchor) ?? []).filter((other) => other !== value);
    if (peers.length === 0) {
      map.set(value, `${anchor}*`);
      continue;
    }

    const start = Math.min(2, value.length);
    const center = value.length / 2;
    let chosen: string | undefined;

    for (let length = 1; length <= value.length - start && chosen === undefined; length += 1) {
      let best: { infix: string; distance: number } | undefined;
      for (let position = start; position + length <= value.length; position += 1) {
        const candidate = value.slice(position, position + length);
        if (peers.some((peer) => peer.includes(candidate))) continue;
        const distance = Math.abs(position + length / 2 - center);
        if (!best || distance < best.distance) best = { infix: candidate, distance };
      }
      chosen = best?.infix;
    }

    map.set(value, chosen === undefined ? `${anchor}*` : `${anchor}*${chosen}*`);
  }

  const byMask = new Map<string, string[]>();
  for (const value of unique) {
    const mask = map.get(value) ?? "";
    const collided = byMask.get(mask) ?? [];
    collided.push(value);
    byMask.set(mask, collided);
  }

  for (const collided of byMask.values()) {
    if (collided.length < 2) continue;
    for (const value of collided) {
      let length = Math.min(2, value.length);
      while (
        length < value.length &&
        collided.some((other) => other !== value && other.startsWith(value.slice(0, length)))
      ) {
        length += 1;
      }
      map.set(value, `${value.slice(0, length)}*`);
    }
  }

  return map;
}

const REPORT_METADATA_IDENTITY_KEYS = ["email", "accountId", "projectId", "orgId", "orgName"] as const;
const ACCOUNT_IDENTITY_KEYS = ["email", "accountId", "projectId", "enterpriseUrl", "orgId", "orgName"] as const;
const LIMIT_SCOPE_IDENTITY_KEYS = ["accountId", "projectId", "orgId"] as const;

function collectIdentityStrings(payload: Record<string, unknown>): string[] {
  const values: string[] = [];

  const collectRecord = (record: Record<string, unknown>, keys: readonly string[]) => {
    for (const key of keys) {
      const value = nonEmptyString(record[key]);
      if (value) values.push(value);
    }
  };

  const reports = Array.isArray(payload.reports) ? payload.reports : [];
  for (const rawReport of reports) {
    if (!isRecord(rawReport)) continue;
    if (isRecord(rawReport.metadata)) {
      collectRecord(rawReport.metadata, REPORT_METADATA_IDENTITY_KEYS);
    }
    const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
    for (const rawLimit of limits) {
      if (isRecord(rawLimit) && isRecord(rawLimit.scope)) {
        collectRecord(rawLimit.scope, LIMIT_SCOPE_IDENTITY_KEYS);
      }
    }
  }

  for (const key of ["accountsWithoutUsage", "disabledCredentials"] as const) {
    const entries = Array.isArray(payload[key]) ? payload[key] : [];
    for (const entry of entries) {
      if (isRecord(entry)) collectRecord(entry, ACCOUNT_IDENTITY_KEYS);
    }
  }

  return values;
}

function redactValue(value: unknown, redaction: Map<string, string>): unknown {
  return typeof value === "string" ? (redaction.get(value) ?? value) : value;
}

function redactIdentityRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
  redaction: Map<string, string>,
): Record<string, unknown> {
  const result = { ...record };
  for (const key of keys) result[key] = redactValue(result[key], redaction);
  return result;
}

function safeResetSelector(value: unknown): string | undefined {
  const selector = nonEmptyString(value);
  if (!selector || selector.length > 512 || /[\r\n]/.test(selector)) return undefined;
  return selector;
}

function pruneTargets(now = Date.now()): void {
  const current = state();
  for (const [id, target] of current.targets) {
    if (target.expiresAt <= now) current.targets.delete(id);
  }
}

/**
 * OMP's unredacted usage output is needed server-side so a later reset action
 * can target the exact saved account. This function immediately masks all
 * identity-bearing fields before the usage payload is cached or parsed for the
 * browser, and replaces the real identity with an opaque, short-lived UUID.
 */
export function sanitizeProviderUsageOutput(
  output: string,
  options: { generation?: number; now?: number } = {},
): string {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("omp usage returned an invalid response");

  const now = options.now ?? Date.now();
  const expectedGeneration = options.generation ?? state().generation;
  const redaction = buildRedactionMap(collectIdentityStrings(payload));
  const pendingTargets: Array<[string, ResetTarget]> = [];
  const reports = Array.isArray(payload.reports) ? payload.reports : [];

  const sanitizedReports = reports.map((rawReport) => {
    if (!isRecord(rawReport)) return rawReport;
    const provider = nonEmptyString(rawReport.provider);
    const rawMetadata = isRecord(rawReport.metadata) ? rawReport.metadata : undefined;
    let targetId: string | undefined;

    if (provider === "openai-codex" && isRecord(rawReport.resetCredits) && rawMetadata) {
      const accountId = safeResetSelector(rawMetadata.accountId);
      const email = safeResetSelector(rawMetadata.email);
      if (accountId || email) {
        targetId = randomUUID();
        pendingTargets.push([
          targetId,
          {
            provider,
            ...(accountId ? { accountId } : {}),
            ...(email ? { email } : {}),
            expiresAt: now + RESET_TARGET_TTL_MS,
          },
        ]);
      }
    }

    const metadata = rawMetadata
      ? redactIdentityRecord(rawMetadata, REPORT_METADATA_IDENTITY_KEYS, redaction)
      : undefined;
    if (metadata && targetId) metadata.__ompwebResetTargetId = targetId;

    const limits = Array.isArray(rawReport.limits)
      ? rawReport.limits.map((rawLimit) => {
          if (!isRecord(rawLimit) || !isRecord(rawLimit.scope)) return rawLimit;
          return {
            ...rawLimit,
            scope: redactIdentityRecord(rawLimit.scope, LIMIT_SCOPE_IDENTITY_KEYS, redaction),
          };
        })
      : rawReport.limits;

    return {
      ...rawReport,
      ...(metadata ? { metadata } : {}),
      ...(limits !== undefined ? { limits } : {}),
    };
  });

  const sanitizeAccountCollection = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((entry) =>
      isRecord(entry) ? redactIdentityRecord(entry, ACCOUNT_IDENTITY_KEYS, redaction) : entry,
    );
  };

  if (expectedGeneration === state().generation) {
    pruneTargets(now);
    for (const [id, target] of pendingTargets) state().targets.set(id, target);
  }

  return JSON.stringify({
    ...payload,
    reports: sanitizedReports,
    ...(payload.accountsWithoutUsage !== undefined
      ? { accountsWithoutUsage: sanitizeAccountCollection(payload.accountsWithoutUsage) }
      : {}),
    ...(payload.disabledCredentials !== undefined
      ? { disabledCredentials: sanitizeAccountCollection(payload.disabledCredentials) }
      : {}),
  });
}

function resetOutcomeFromOutput(output: string): ProviderUsageResetResultCode {
  const normalized = output.toLowerCase();
  if (normalized.includes("reset applied for")) return "reset";
  if (normalized.includes("already redeemed")) return "already_redeemed";
  if (normalized.includes("nothing to reset right now")) return "nothing_to_reset";
  if (normalized.includes("no saved resets")) return "no_credit";
  if (normalized.includes("couldn't load") || normalized.includes("could not load saved resets")) {
    return "credit_list_failed";
  }
  if (normalized.includes("could not authenticate")) return "account_unavailable";
  if (
    normalized.includes("could not find a stored codex account") ||
    normalized.includes("no codex account matches")
  ) {
    return "no_account";
  }
  return "unknown";
}

async function runResetCommand(selector: string): Promise<string> {
  const output: string[] = [];
  const proc = new RpcProcess({
    cwd: homedir(),
    extraArgs: UTILITY_EXTRA_ARGS,
    onFrame: (frame) => {
      if (frame.type === "command_output" && typeof frame.text === "string") output.push(frame.text);
    },
  });

  try {
    const ready = await proc.waitReady(RESET_COMMAND_TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
    await proc.sendCommand(
      { type: "prompt", message: `/usage reset ${selector}` },
      RESET_COMMAND_TIMEOUT_MS,
    );
    return output.join("\n");
  } finally {
    await proc.dispose();
  }
}

export async function redeemProviderUsageReset(targetId: string): Promise<ProviderUsageResetResult> {
  pruneTargets();
  const current = state();
  const target = current.targets.get(targetId);
  if (!target || target.expiresAt <= Date.now()) {
    return { ok: false, code: "stale_target" };
  }
  if (target.provider !== "openai-codex") {
    return { ok: false, code: "no_account" };
  }

  const selector = target.accountId ?? target.email;
  if (!selector) return { ok: false, code: "no_account" };

  const lockKey = `${target.provider}\0${selector}`;
  if (current.inFlightAccounts.has(lockKey)) {
    return { ok: false, code: "in_progress" };
  }
  current.inFlightAccounts.add(lockKey);

  try {
    const commandOutput = await runResetCommand(selector);
    const code = resetOutcomeFromOutput(commandOutput);
    return { ok: code === "reset", code };
  } finally {
    current.inFlightAccounts.delete(lockKey);
    invalidateProviderUsageResetTargets();
  }
}
