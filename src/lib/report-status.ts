/** Additive #150 report settlement. Stale progress must not keep thinking. */

export const REPORT_SETTLED_STATUSES = ["pending", "terminal", "failed", "delivery_failed"] as const;
export type ReportSettledStatus = (typeof REPORT_SETTLED_STATUSES)[number];

export function isReportSettledStatus(value: unknown): value is ReportSettledStatus {
  return typeof value === "string" && (REPORT_SETTLED_STATUSES as readonly string[]).includes(value);
}

export function reportShowsThinking(report: { kind?: string; status?: string } | undefined | null): boolean {
  if (!report) return false;
  if (isReportSettledStatus(report.status)) return false;
  return report.kind === "progress";
}
