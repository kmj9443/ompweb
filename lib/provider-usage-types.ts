export type ProviderUsageWindowId = "5h" | "7d" | "monthly";

export interface ProviderUsageWindow {
  percent: number;
  resetMinutes?: number;
  resetHours?: number;
}

export interface ProviderUsageResetCreditDetail {
  grantedAt?: string;
  expiresAt?: string;
  status?: string;
}

export interface ProviderUsageResetCredits {
  availableCount: number;
  credits?: ProviderUsageResetCreditDetail[];
}

export interface ProviderUsageReport {
  provider: string;
  accountLabel?: string;
  accountIndex?: number;
  plan?: string;
  modelId?: string;
  tier?: string;
  noLimits?: boolean;
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  monthly?: ProviderUsageWindow;
  resetCredits?: ProviderUsageResetCredits;
  /** Opaque, short-lived server token used to redeem one saved reset for this account. */
  resetTargetId?: string;
}

export interface ProviderUsageSnapshot {
  generatedAt: number | null;
  reports: ProviderUsageReport[];
}

export interface ProviderUsageContext {
  provider: string;
  modelId: string;
}
