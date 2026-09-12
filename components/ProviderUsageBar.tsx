"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Gauge } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatUsageReset, usageTone, useProviderUsage } from "./AppShell-provider-usage";
import type { ProviderUsageReport, ProviderUsageWindow } from "@/lib/provider-usage-types";

interface WindowDef {
  short: string;
  labelKey: string;
  pick: (report: ProviderUsageReport) => ProviderUsageWindow | undefined;
}

const WINDOWS: WindowDef[] = [
  { short: "5H", labelKey: "providerUsage.window5h", pick: (r) => r.fiveHour },
  { short: "7D", labelKey: "providerUsage.window7d", pick: (r) => r.sevenDay },
  { short: "30D", labelKey: "providerUsage.window30d", pick: (r) => r.monthly },
];

const COLLAPSED_STORAGE_KEY = "omp-web:provider-usage-collapsed";

function worstWindow(report: ProviderUsageReport): { short: string; labelKey: string; window: ProviderUsageWindow } | null {
  let best: { short: string; labelKey: string; window: ProviderUsageWindow } | null = null;
  for (const def of WINDOWS) {
    const window = def.pick(report);
    if (window && (best === null || window.percent > best.window.percent)) {
      best = { short: def.short, labelKey: def.labelKey, window };
    }
  }
  return best;
}

function DetailMeter({ short, window, locale, t }: {
  short: string;
  window: ProviderUsageWindow;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const usedPct = Math.round(window.percent);
  const remainingPct = Math.max(0, Math.min(100, 100 - usedPct));
  const tone = usageTone(usedPct);
  const rawReset = window.resetMinutes ?? window.resetHours;
  const reset = rawReset !== undefined
    ? formatUsageReset(rawReset, window.resetMinutes !== undefined ? "minutes" : "hours", locale)
    : null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        width: "100%",
        minWidth: 0,
      }}
    >
      <span
        style={{
          display: "grid",
          gridTemplateColumns: "28px 34px minmax(0, 1fr)",
          alignItems: "baseline",
          columnGap: 4,
          width: "100%",
          minWidth: 0,
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
          {short}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {remainingPct}%
        </span>
        <span style={{ fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap", justifySelf: "end" }}>
          {reset ?? ""}
        </span>
      </span>
      <span style={{ display: "block", width: "100%", height: 4, minHeight: 4, maxHeight: 4, lineHeight: 0, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
        <span style={{ display: "block", width: `${remainingPct}%`, height: 4, minHeight: 4, maxHeight: 4, borderRadius: 2, background: tone }} />
      </span>
    </div>
  );
}

function soonestResetExpiry(report: ProviderUsageReport): string | null {
  const credits = report.resetCredits?.credits ?? [];
  const candidates = credits
    .filter((credit) => (credit.status ?? "available") === "available" && credit.expiresAt)
    .map((credit) => ({ value: credit.expiresAt!, time: Date.parse(credit.expiresAt!) }))
    .filter((credit) => Number.isFinite(credit.time))
    .sort((a, b) => a.time - b.time);
  return candidates[0]?.value ?? null;
}

function formatResetExpiry(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const includeYear = date.getFullYear() !== now.getFullYear();
  try {
    return new Intl.DateTimeFormat(locale, {
      ...(includeYear ? { year: "numeric" as const } : {}),
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function resetFeedbackKey(code: string | undefined): string {
  switch (code) {
    case "reset":
      return "providerUsage.resetApplied";
    case "nothing_to_reset":
      return "providerUsage.resetNothingToReset";
    case "no_credit":
    case "already_redeemed":
      return "providerUsage.resetNoCredit";
    case "stale_target":
      return "providerUsage.resetTargetExpired";
    case "in_progress":
      return "providerUsage.resetInProgress";
    default:
      return "providerUsage.resetFailed";
  }
}

// Provider rate-limit block pinned above Settings in the sidebar.
// The whole section can collapse, while every account detail stays permanently
// expanded whenever the section itself is open.
export function ProviderUsageBar() {
  const { t, locale } = useI18n();
  const { snapshot, loading, error, refresh } = useProviderUsage("", 5 * 60_000);
  const reports = snapshot?.reports ?? [];
  const [collapsed, setCollapsed] = useState(true);
  const [armedTarget, setArmedTarget] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ account: string; key: string; ok: boolean } | null>(null);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "false") setCollapsed(false);
    } catch {
      // Storage unavailable: keep the collapsed default.
    }
  }, []);

  useEffect(() => {
    if (!armedTarget) return;
    const timer = window.setTimeout(() => {
      setArmedTarget((current) => current === armedTarget ? null : current);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [armedTarget]);

  let worst: { usedPercent: number; remainingPercent: number; window: string } | null = null;
  for (const report of reports) {
    const best = worstWindow(report);
    if (best && (worst === null || best.window.percent > worst.usedPercent)) {
      const usedPercent = Math.round(best.window.percent);
      worst = {
        usedPercent,
        remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
        window: t(best.labelKey),
      };
    }
  }

  const redeemReset = async (report: ProviderUsageReport, account: string) => {
    const targetId = report.resetTargetId;
    if (!targetId || (report.resetCredits?.availableCount ?? 0) <= 0 || pendingTarget) return;
    if (armedTarget !== targetId) {
      setArmedTarget(targetId);
      setFeedback(null);
      return;
    }

    setArmedTarget(null);
    setPendingTarget(targetId);
    try {
      const response = await fetch("/api/provider-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "redeem-reset", targetId }),
      });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; code?: string };
      setFeedback({
        account: `${report.provider}:${account}`,
        key: resetFeedbackKey(result.code),
        ok: result.code === "reset",
      });
    } catch {
      setFeedback({
        account: `${report.provider}:${account}`,
        key: "providerUsage.resetFailed",
        ok: false,
      });
    } finally {
      setPendingTarget(null);
      refresh();
    }
  };

  const shownResetTargets = new Set<string>();

  return (
    <section
      aria-label={t("appShell.sectionProviderUsage")}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 8px 6px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
        minHeight: 0,
        maxHeight: "50vh",
        overflowY: "auto",
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => {
          const next = !value;
          try {
            window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
          } catch {
            // The preference still applies for this page load.
          }
          return next;
        })}
        aria-expanded={!collapsed}
        title={t("appShell.sectionProviderUsage")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          boxSizing: "border-box",
          padding: "0 4px 3px",
          minWidth: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <ChevronRight
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform var(--dur-med) var(--ease-out-warm)",
          }}
        />
        <span aria-hidden="true" style={{ display: "flex", color: "var(--accent)", flexShrink: 0 }}>
          <Gauge size={13} strokeWidth={2} aria-hidden="true" />
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("appShell.sectionProviderUsage")}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--font-ui)", color: worst ? usageTone(worst.usedPercent) : "var(--text-dim)", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          {loading && reports.length === 0
            ? t("appShell.providerUsageLoading")
            : error
              ? t("appShell.providerUsageUnavailable")
              : worst
                ? t("providerUsage.remaining", { percent: worst.remainingPercent, window: worst.window })
                : t("appShell.providerUsageNoData")}
        </span>
      </button>
      {!collapsed && reports.map((report, index) => {
        const account = report.accountLabel ?? t("appShell.account", { number: report.accountIndex ?? index + 1 });
        const key = `${report.provider}:${account}:${report.modelId ?? "all"}:${index}`;
        const resetGroupKey = report.resetTargetId ?? `${report.provider}:${account}:reset`;
        const showResetCredits = Boolean(report.resetCredits) && !shownResetTargets.has(resetGroupKey);
        if (showResetCredits) shownResetTargets.add(resetGroupKey);
        const resetCount = report.resetCredits?.availableCount ?? 0;
        const expiry = showResetCredits ? soonestResetExpiry(report) : null;
        const feedbackAccount = `${report.provider}:${account}`;

        return (
          <div
            key={key}
            style={{
              borderBottom: index < reports.length - 1
                ? "1px solid color-mix(in srgb, var(--border) 76%, transparent)"
                : undefined,
            }}
          >
            <div
              title={account}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                boxSizing: "border-box",
                padding: "5px 6px 3px",
                textAlign: "left",
                minWidth: 0,
              }}
            >
              <span style={{ fontFamily: "var(--font-ui)", fontWeight: 700, fontSize: 10, color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", padding: "0 5px", borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0, lineHeight: 1.7 }}>
                {report.provider}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {account}
              </span>
              {report.noLimits && (
                <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>∞</span>
              )}
            </div>
            {!report.noLimits && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 8px 6px 6px", fontFamily: "var(--font-ui)" }}>
                {WINDOWS.map((def) => {
                  const window = def.pick(report);
                  return window ? <DetailMeter key={def.short} short={t(def.labelKey)} window={window} locale={locale} t={t} /> : null;
                })}
              </div>
            )}
            {showResetCredits && (
              <div style={{ padding: "0 8px 7px 6px", fontFamily: "var(--font-ui)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: resetCount > 0 ? "var(--accent)" : "var(--text-dim)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("providerUsage.resetCredits", { count: resetCount })}
                  </span>
                  {expiry && (
                    <span style={{ fontSize: 9, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t("providerUsage.resetCreditExpires", { date: formatResetExpiry(expiry, locale) })}
                    </span>
                  )}
                  {resetCount > 0 && report.resetTargetId && (
                    <button
                      type="button"
                      disabled={pendingTarget !== null}
                      onClick={() => void redeemReset(report, account)}
                      title={armedTarget === report.resetTargetId ? t("providerUsage.resetConfirmHint") : t("providerUsage.resetUseHint")}
                      style={{
                        marginLeft: "auto",
                        flexShrink: 0,
                        border: `1px solid ${armedTarget === report.resetTargetId ? "var(--status-warning)" : "var(--border)"}`,
                        borderRadius: 5,
                        padding: "2px 6px",
                        background: "var(--bg)",
                        color: armedTarget === report.resetTargetId ? "var(--status-warning)" : "var(--text-muted)",
                        font: "inherit",
                        fontSize: 9,
                        fontWeight: 700,
                        cursor: pendingTarget ? "default" : "pointer",
                        opacity: pendingTarget && pendingTarget !== report.resetTargetId ? 0.45 : 1,
                      }}
                    >
                      {pendingTarget === report.resetTargetId
                        ? t("providerUsage.resetUsing")
                        : armedTarget === report.resetTargetId
                          ? t("providerUsage.resetConfirm")
                          : t("providerUsage.resetUse")}
                    </button>
                  )}
                </div>
                {feedback?.account === feedbackAccount && (
                  <div style={{ marginTop: 4, fontSize: 9, lineHeight: 1.35, color: feedback.ok ? "var(--accent)" : "var(--text-dim)" }}>
                    {t(feedback.key)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
