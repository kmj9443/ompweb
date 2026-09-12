import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { promisify } from "util";
import { resolveOmpBin } from "./omp/omp-cli";
import { RpcProcess } from "./omp/rpc-process";
import { asNumber, isRecord } from "./type-guards";
import type {
  ProviderUsageReport,
  ProviderUsageResetCredits,
  ProviderUsageSnapshot,
  ProviderUsageWindowId,
} from "./provider-usage-types";

const execFileAsync = promisify(execFile);
const USAGE_TIMEOUT_MS = 30_000;
const USAGE_MAX_BUFFER = 4 * 1024 * 1024;
const USAGE_CACHE_TTL_MS = 5 * 60_000;
const RESET_COMMAND_TIMEOUT_MS = 60_000;
const RESET_TARGET_TTL_MS = USAGE_CACHE_TTL_MS + 60_000;
const UTILITY_EXTRA_ARGS = ["--no-session", "--no-skills", "--no-lsp"];

type UsageQuery = { provider?: string; modelId?: string };

type CachedUsage = { expiresAt: number; output: string };

type ResetTarget = {
  provider: string;
  accountId?: string;
  email?: string;
  expiresAt: number;
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

let usageCache: CachedUsage | undefined;
let usageInFlight: Promise<string> | undefined;
let usageGeneration = 0;

declare global {
  var __ompProviderUsageResetTargets: Map<string, ResetTarget> | undefined;
  var __ompProviderUsageResetInFlight: Set<string> | undefined;
}

function resetTargets(): Map<string, ResetTarget> {
  globalThis.__ompProviderUsageResetTargets ??= new Map();
  return globalThis.__ompProviderUsageResetTargets;
}

function resetInFlight(): Set<string> {
  globalThis.__ompProviderUsageResetInFlight ??= new Set();
  return globalThis.__ompProviderUsageResetInFlight;
}

function pruneResetTargets(now = Date.now()): void {
  for (const [id, target] of resetTargets()) {
    if (target.expiresAt <= now) resetTargets().delete(id);
  }
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
    const list = byAnchor.get(anchor) ?? [];
    list.push(value);
    byAnchor.set(anchor, list);
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
      for (let pos = start; pos + length <= value.length; pos += 1) {
        const candidate = value.slice(pos, pos + length);
        if (peers.some((peer) => peer.includes(candidate))) continue;
        const distance = Math.abs(pos + length / 2 - center);
        if (!best || distance < best.distance) best = { infix: candidate, distance };
      }
      chosen = best?.infix;
    }
    map.set(value, chosen === undefined ? `${anchor}*` : `${anchor}*${chosen}*`);
  }

  const byMask = new Map<string, string[]>();
  for (const value of unique) {
    const mask = map.get(value) ?? "";
    const list = byMask.get(mask) ?? [];
    list.push(value);
    byMask.set(mask, list);
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

const IDENTITY_METADATA_KEYS = ["email", "accountId", "projectId", "orgId", "orgName"] as const;
const IDENTITY_SCOPE_KEYS = ["accountId", "projectId", "orgId"] as const;

function collectIdentityStrings(payload: Record<string, unknown>): string[] {
  const values: string[] = [];
  const reports = Array.isArray(payload.reports) ? payload.reports : [];
  for (const rawReport of reports) {
    if (!isRecord(rawReport)) continue;
    const metadata = isRecord(rawReport.metadata) ? rawReport.metadata : undefined;
    if (metadata) {
      for (const key of IDENTITY_METADATA_KEYS) {
        const value = nonEmptyString(metadata[key]);
        if (value) values.push(value);
      }
    }
    const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
    for (const rawLimit of limits) {
      if (!isRecord(rawLimit) || !isRecord(rawLimit.scope)) continue;
      for (const key of IDENTITY_SCOPE_KEYS) {
        const value = nonEmptyString(rawLimit.scope[key]);
        if (value) values.push(value);
      }
    }
  }
  return values;
}

function redactValue(value: unknown, redaction: Map<string, string>): unknown {
  return typeof value === "string" ? (redaction.get(value) ?? value) : value;
}

function safeResetSelector(value: unknown): string | undefined {
  const selector = nonEmptyString(value);
  if (!selector || selector.length > 512 || /[\r\n]/.test(selector)) return undefined;
  return selector;
}

function prepareProviderUsageOutput(output: string, now = Date.now()): {
  output: string;
  targets: Array<[string, ResetTarget]>;
} {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("omp usage returned an invalid response");

  const redaction = buildRedactionMap(collectIdentityStrings(payload));
  const targets: Array<[string, ResetTarget]> = [];
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
        targets.push([
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

    let metadata = rawMetadata;
    if (rawMetadata) {
      metadata = { ...rawMetadata };
      for (const key of IDENTITY_METADATA_KEYS) {
        metadata[key] = redactValue(metadata[key], redaction);
      }
      if (targetId) metadata.__ompwebResetTargetId = targetId;
    }

    const limits = Array.isArray(rawReport.limits)
      ? rawReport.limits.map((rawLimit) => {
          if (!isRecord(rawLimit) || !isRecord(rawLimit.scope)) return rawLimit;
          const scope = { ...rawLimit.scope };
          for (const key of IDENTITY_SCOPE_KEYS) scope[key] = redactValue(scope[key], redaction);
          return { ...rawLimit, scope };
        })
      : rawReport.limits;

    return {
      ...rawReport,
      ...(metadata ? { metadata } : {}),
      ...(limits !== undefined ? { limits } : {}),
    };
  });

  return {
    output: JSON.stringify({ ...payload, reports: sanitizedReports }),
    targets,
  };
}

/**
 * Convert an unredacted `omp usage --json` response into the same safe shape
 * the browser previously received from `--redact`. Real account identifiers
 * never leave the server; a short-lived opaque reset target is injected instead.
 */
export function sanitizeProviderUsageOutput(output: string, now = Date.now()): string {
  return prepareProviderUsageOutput(output, now).output;
}

function normalizeWindowId(scope: Record<string, unknown>, window: Record<string, unknown>): ProviderUsageWindowId | undefined {
  const windowId = nonEmptyString(scope.windowId);
  if (windowId === "5h" || windowId === "7d" || windowId === "monthly" || windowId === "30d" || windowId === "daily") {
    if (windowId === "30d") return "monthly";
    if (windowId === "daily") return "5h";
    return windowId;
  }
  const durationMs = asNumber(window.durationMs);
  if (durationMs === undefined) return undefined;
  if (Math.abs(durationMs - 5 * 60 * 60 * 1000) <= 60_000) return "5h";
  if (Math.abs(durationMs - 7 * 24 * 60 * 60 * 1000) <= 60_000) return "7d";
  if (Math.abs(durationMs - 30 * 24 * 60 * 60 * 1000) <= 60 * 60 * 1000) return "monthly";
  if (Math.abs(durationMs - 24 * 60 * 60 * 1000) <= 60_000) return "5h";
  return undefined;
}

function usageWindow(
  windowId: ProviderUsageWindowId,
  fraction: number,
  window: Record<string, unknown>,
  now: number,
): ProviderUsageReport["fiveHour"] {
  const resetAt = asNumber(window.resetsAt);
  if (windowId === "5h") {
    return {
      percent: fraction * 100,
      ...(resetAt !== undefined ? { resetMinutes: Math.max(0, Math.round((resetAt - now) / 60_000)) } : {}),
    };
  }
  return {
    percent: fraction * 100,
    ...(resetAt !== undefined ? { resetHours: Math.max(0, Math.round((resetAt - now) / 3_600_000)) } : {}),
  };
}

function accountLabel(metadata: Record<string, unknown> | undefined): string | undefined {
  return nonEmptyString(metadata?.email) ?? nonEmptyString(metadata?.accountId);
}

function normalizeResetCredits(rawReport: Record<string, unknown>): ProviderUsageResetCredits | undefined {
  if (!isRecord(rawReport.resetCredits)) return undefined;
  const availableCount = asNumber(rawReport.resetCredits.availableCount);
  if (availableCount === undefined) return undefined;
  const rawCredits = Array.isArray(rawReport.resetCredits.credits) ? rawReport.resetCredits.credits : undefined;
  const credits = rawCredits?.flatMap((rawCredit) => {
    if (!isRecord(rawCredit)) return [];
    const grantedAt = nonEmptyString(rawCredit.grantedAt);
    const expiresAt = nonEmptyString(rawCredit.expiresAt);
    const status = nonEmptyString(rawCredit.status);
    return [{
      ...(grantedAt ? { grantedAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(status ? { status } : {}),
    }];
  });
  return {
    availableCount: Math.max(0, Math.trunc(availableCount)),
    ...(credits ? { credits } : {}),
  };
}

type UsageLimit = { id: ProviderUsageWindowId; fraction: number; window: Record<string, unknown> };

type UsageGroup = {
  priority: number;
  modelId?: string;
  tier?: string;
  limits: Map<ProviderUsageWindowId, UsageLimit>;
};

function normalizeReport(
  rawReport: Record<string, unknown>,
  query: UsageQuery,
  now: number,
  reportIndex: number,
): ProviderUsageReport[] {
  const provider = nonEmptyString(rawReport.provider);
  if (!provider || (query.provider && provider !== query.provider)) return [];
  const limits = Array.isArray(rawReport.limits) ? rawReport.limits : [];
  const activeModelId = query.modelId?.toLowerCase();
  const groups = new Map<string, UsageGroup>();

  for (const rawLimit of limits) {
    if (!isRecord(rawLimit) || !isRecord(rawLimit.scope) || !isRecord(rawLimit.amount)) continue;
    const scope = rawLimit.scope;
    const amount = rawLimit.amount;
    const fraction = asNumber(amount.usedFraction);
    if (fraction === undefined) continue;
    const window = isRecord(rawLimit.window) ? rawLimit.window : {};
    const windowId = normalizeWindowId(scope, window);
    if (!windowId) continue;
    const modelId = nonEmptyString(scope.modelId);
    if (activeModelId && modelId && modelId.toLowerCase() !== activeModelId) continue;
    const tier = nonEmptyString(scope.tier);
    const normalizedModelId = modelId?.toLowerCase();
    const normalizedTier = tier?.toLowerCase();
    const groupKey = `${normalizedModelId ?? ""}\0${normalizedTier ?? ""}`;
    const priority = modelId ? (normalizedTier ? 0 : 1) : normalizedTier ? 2 : 3;
    let group = groups.get(groupKey);
    if (!group) {
      group = { priority, modelId, tier, limits: new Map() };
      groups.set(groupKey, group);
    }
    const candidate = { id: windowId, fraction, window };
    const current = group.limits.get(windowId);
    if (!current || fraction > current.fraction) group.limits.set(windowId, candidate);
  }

  const selectedGroups = [...groups.values()];
  if (activeModelId && selectedGroups.length > 0) {
    const selected = selectedGroups.reduce((best, group) => group.priority < best.priority ? group : best);
    selectedGroups.splice(0, selectedGroups.length, selected);
  }
  const metadata = isRecord(rawReport.metadata) ? rawReport.metadata : undefined;
  const label = accountLabel(metadata);
  const plan = nonEmptyString(metadata?.planType);
  const resetCredits = normalizeResetCredits(rawReport);
  const resetTargetId = nonEmptyString(metadata?.__ompwebResetTargetId);
  const resetFields = {
    ...(resetCredits ? { resetCredits } : {}),
    ...(resetTargetId ? { resetTargetId } : {}),
  };

  if (selectedGroups.length === 0) {
    return [{
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      ...resetFields,
      noLimits: true,
    }];
  }
  return selectedGroups.flatMap((group) => {
    const result: ProviderUsageReport = {
      provider,
      ...(label ? { accountLabel: label } : {}),
      ...(!label ? { accountIndex: reportIndex + 1 } : {}),
      ...(plan ? { plan } : {}),
      ...(group.modelId ? { modelId: group.modelId } : {}),
      ...(group.tier ? { tier: group.tier } : {}),
      ...resetFields,
    };
    for (const candidate of group.limits.values()) {
      const normalized = usageWindow(candidate.id, candidate.fraction, candidate.window, now);
      if (candidate.id === "5h" && !result.fiveHour) result.fiveHour = normalized;
      if (candidate.id === "7d" && !result.sevenDay) result.sevenDay = normalized;
      if (candidate.id === "monthly" && !result.monthly) result.monthly = normalized;
    }
    return result.fiveHour || result.sevenDay || result.monthly ? [result] : [];
  });
}

export function parseProviderUsageOutput(output: string, query: UsageQuery = {}, now = Date.now()): ProviderUsageSnapshot {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("omp usage returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("omp usage returned an invalid response");
  const rawReports = Array.isArray(payload.reports) ? payload.reports : [];
  const reports = rawReports.flatMap((report, index) => isRecord(report) ? normalizeReport(report, query, now, index) : []);
  const generatedAt = asNumber(payload.generatedAt) ?? null;
  return { generatedAt, reports };
}

async function fetchProviderUsage(generation: number): Promise<string> {
  const bin = resolveOmpBin();
  if (!bin) throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  const { stdout } = await execFileAsync(bin, ["usage", "--json"], {
    timeout: USAGE_TIMEOUT_MS,
    maxBuffer: USAGE_MAX_BUFFER,
    windowsHide: true,
  });
  const prepared = prepareProviderUsageOutput(stdout);
  if (generation === usageGeneration) {
    pruneResetTargets();
    for (const [id, target] of prepared.targets) resetTargets().set(id, target);
  }
  return prepared.output;
}

function getUsageOutput(): Promise<string> {
  if (usageCache && usageCache.expiresAt > Date.now()) return Promise.resolve(usageCache.output);
  if (usageInFlight) return usageInFlight;
  const generation = usageGeneration;
  const inFlight = fetchProviderUsage(generation)
    .then((output) => {
      if (generation === usageGeneration) {
        usageCache = { output, expiresAt: Date.now() + USAGE_CACHE_TTL_MS };
      }
      return output;
    })
    .finally(() => {
      if (usageInFlight === inFlight) usageInFlight = undefined;
    });
  usageInFlight = inFlight;
  return inFlight;
}

export function invalidateProviderUsageCache(): void {
  usageGeneration += 1;
  usageCache = undefined;
  resetTargets().clear();
}

function resetOutcomeFromOutput(output: string): ProviderUsageResetResultCode {
  const normalized = output.toLowerCase();
  if (normalized.includes("reset applied for")) return "reset";
  if (normalized.includes("already redeemed")) return "already_redeemed";
  if (normalized.includes("nothing to reset right now")) return "nothing_to_reset";
  if (normalized.includes("no saved resets")) return "no_credit";
  if (normalized.includes("couldn't load") || normalized.includes("could not load saved resets")) return "credit_list_failed";
  if (normalized.includes("could not authenticate")) return "account_unavailable";
  if (normalized.includes("could not find a stored codex account") || normalized.includes("no codex account matches")) return "no_account";
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
  pruneResetTargets();
  const target = resetTargets().get(targetId);
  if (!target || target.expiresAt <= Date.now()) {
    return { ok: false, code: "stale_target" };
  }
  if (target.provider !== "openai-codex") {
    return { ok: false, code: "no_account" };
  }

  const inFlight = resetInFlight();
  if (inFlight.has(targetId)) return { ok: false, code: "in_progress" };
  inFlight.add(targetId);

  try {
    const selector = target.accountId ?? target.email;
    if (!selector) return { ok: false, code: "no_account" };
    const commandOutput = await runResetCommand(selector);
    const code = resetOutcomeFromOutput(commandOutput);
    return { ok: code === "reset", code };
  } finally {
    inFlight.delete(targetId);
    invalidateProviderUsageCache();
  }
}

export async function getProviderUsage(query: UsageQuery = {}): Promise<ProviderUsageSnapshot> {
  return parseProviderUsageOutput(await getUsageOutput(), query);
}
