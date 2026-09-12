"use client";

import { Gauge } from "lucide-react";
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
    <span
      style={{
        display: "grid",
        gridTemplateColumns: "36px minmax(48px, 1fr) 32px 92px",
        alignItems: "center",
        columnGap: 6,
        width: "100%",
      }}
    >
      <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em" }}>{short}</span>
      <span style={{ display: "block", width: "100%", height: 4, minHeight: 4, maxHeight: 4, lineHeight: 0, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
        <span style={{ display: "block", width: `${remainingPct}%`, height: 4, minHeight: 4, maxHeight: 4, borderRadius: 2, background: tone }} />
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap" }}>
        {remainingPct}%
      </span>
      <span style={{ fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap", textAlign: "left" }}>
        {reset ? t("providerUsage.resets", { value: reset }) : ""}
      </span>
    </span>
  );
}

// Provider rate-limit block pinned above Settings in the sidebar.
// Keep the section and every account detail permanently expanded for at-a-glance monitoring.
export function ProviderUsageBar() {
  const { t, locale } = useI18n();
  const { snapshot, loading, error } = useProviderUsage("", 5 * 60_000);
  const reports = snapshot?.reports ?? [];

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
      <div
        title={t("appShell.sectionProviderUsage")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          boxSizing: "border-box",
          padding: "0 4px",
          minWidth: 0,
          textAlign: "left",
        }}
      >
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
      </div>
      {reports.map((report, index) => {
        const account = report.accountLabel ?? t("appShell.account", { number: report.accountIndex ?? index + 1 });
        const key = `${report.provider}:${account}:${report.modelId ?? "all"}:${index}`;
        return (
          <div key={key}>
            <div
              title={account}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                boxSizing: "border-box",
                padding: "5px 6px 4px",
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
              <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px 7px 6px", fontFamily: "var(--font-ui)" }}>
                {WINDOWS.map((def) => {
                  const window = def.pick(report);
                  return window ? <DetailMeter key={def.short} short={t(def.labelKey)} window={window} locale={locale} t={t} /> : null;
                })}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
