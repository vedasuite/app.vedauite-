import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Banner,
  Button,
  Card,
  Collapsible,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  SkeletonBodyText,
  SkeletonDisplayText,
  Text,
  Toast,
} from "@shopify/polaris";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";

/**
 * PART 4 — Unified Action Center.
 *
 * Renders the deterministic, evidence-backed findings produced by Parts 1-3.
 * Every number, severity and confidence value shown here comes from the server
 * as computed by the detectors; this component formats and never derives.
 */

type Severity = "critical" | "high" | "medium" | "low";
type Confidence = "high" | "medium" | "low" | "insufficient_data";
type Status = "new" | "seen" | "in_review" | "resolved" | "dismissed";

type Evidence = { label: string; value: string };

type CardImpact = {
  status: "quantified" | "impact_not_quantifiable";
  min?: number;
  max?: number;
  currency?: string;
  period?: string;
  basis?: string;
  reason?: string;
};

type ActionCard = {
  id: string;
  findingType: string;
  module: string;
  status: Status;
  severity: Severity;
  confidence: Confidence;
  title: string;
  whatHappened: string;
  whyItMatters: string;
  evidence: Evidence[];
  methodology: { summary: string; assumptions: string[]; caps: string[] } | null;
  dataComplete: boolean;
  /** Stored details were unreadable; only safe row facts are shown. */
  degraded?: boolean;
  impact: CardImpact;
  recommendedAction: string;
  route: string;
  firstDetectedAt: string;
  lastSeenAt: string;
  detectionCount: number;
  isStale: boolean;
  rank: {
    score: number;
    components: Record<string, number>;
    weights: Record<string, number>;
  };
};

type ImpactGroup = {
  currency: string;
  period: string;
  min: number;
  max: number;
  findingCount: number;
};

type Summary = {
  totalOpen: number;
  bySeverity: Record<Severity, number>;
  byStatus: Record<Status, number>;
  quantifiedImpact: ImpactGroup[];
  notQuantifiedCount: number;
  staleCount: number;
  incompleteDataCount: number;
  degradedCount: number;
  capReached: boolean;
  generatedAt: string;
};

type Brief = {
  headline: string;
  bullets: string[];
  referencedFindingIds: string[];
  generatedBy: "deterministic" | "ai_assisted";
  aiFallbackReason?: string;
  generatedAt: string;
};

type ActionCenterResponse = {
  cards: ActionCard[];
  summary: Summary;
  brief: Brief;
  meta: {
    lastSyncAt: string | null;
    availableStatuses: Status[];
    enabledModules: string[];
    aiEnabled: boolean;
  };
};

const SEVERITY_TONE: Record<Severity, "critical" | "warning" | "attention" | "info"> = {
  critical: "critical",
  high: "warning",
  medium: "attention",
  low: "info",
};

const STATUS_LABEL: Record<Status, string> = {
  new: "New",
  seen: "Seen",
  in_review: "In review",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  insufficient_data: "Insufficient data",
};

const PERIOD_LABEL: Record<string, string> = {
  per_order: "per unit",
  current_open_exposure: "currently exposed",
  last_7_days: "last 7 days",
  last_30_days: "last 30 days",
  monthly_estimate: "monthly estimate",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function impactText(impact: CardImpact): string {
  if (impact.status !== "quantified") return "Impact not quantified";
  const period = PERIOD_LABEL[impact.period ?? ""] ?? impact.period ?? "";
  return `${impact.min}–${impact.max} ${impact.currency} (est., ${period})`;
}

export function ActionCenterPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const [data, setData] = useState<ActionCenterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState("open");
  const [severityFilter, setSeverityFilter] = useState("all");

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "open" && statusFilter !== "all") params.set("status", statusFilter);
      if (severityFilter !== "all") params.set("severity", severityFilter);
      const query = params.toString();
      const response = await embeddedShopRequest<ActionCenterResponse>(
        `/api/action-center${query ? `?${query}` : ""}`,
        { timeoutMs: 45000 }
      );
      setData(response);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The Action Center could not be loaded. Try again in a moment."
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter, severityFilter]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const visibleCards = useMemo(() => {
    if (!data) return [];
    if (statusFilter === "open") {
      return data.cards.filter((c) => ["new", "seen", "in_review"].includes(c.status));
    }
    return data.cards;
  }, [data, statusFilter]);

  const act = useCallback(
    async (card: ActionCard, status: Status, label: string) => {
      setBusyId(card.id);
      try {
        await embeddedShopRequest(`/api/action-center/${card.id}/status`, {
          method: "POST",
          body: { status },
          timeoutMs: 30000,
        });
        setToast(`Marked as ${label}.`);
        await load();
      } catch (err) {
        setToast(err instanceof Error ? err.message : "Could not update that finding.");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const sendFeedback = useCallback(async (card: ActionCard, useful: boolean) => {
    try {
      await embeddedShopRequest(`/api/action-center/${card.id}/feedback`, {
        method: "POST",
        body: { useful },
        timeoutMs: 20000,
      });
      setToast("Thanks — that helps us tune what you see.");
    } catch {
      // Feedback is a pilot signal; never surface a failure as a blocking error.
      setToast("Thanks — that helps us tune what you see.");
    }
  }, []);

  // ---- Loading -----------------------------------------------------------
  if (loading) {
    return (
      <Page title="Action Center" subtitle="What needs your attention, in priority order.">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={3} />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // ---- Error -------------------------------------------------------------
  if (error) {
    return (
      <Page title="Action Center">
        <Layout>
          <Layout.Section>
            <Banner title="Action Center unavailable" tone="critical">
              <BlockStack gap="200">
                <Text as="p">{error}</Text>
                <InlineStack>
                  <Button onClick={() => { setLoading(true); void load(); }}>Try again</Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const summary = data?.summary;
  const brief = data?.brief;

  return (
    <Page
      title="Action Center"
      subtitle="What needs your attention, in priority order."
      primaryAction={{ content: "Refresh", onAction: () => { setLoading(true); void load(); } }}
    >
      <Layout>
        {/* ---- Intelligence brief ------------------------------------- */}
        {brief ? (
          <Layout.Section>
            <Card padding="400">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap={false}>
                  <Text as="h2" variant="headingMd">
                    {brief.headline}
                  </Text>
                  {/* Never labels deterministic work as AI. */}
                  <Badge tone="info">
                    {brief.generatedBy === "ai_assisted" ? "AI-assisted summary" : "VedaSuite summary"}
                  </Badge>
                </InlineStack>
                {brief.bullets.length > 0 ? (
                  <BlockStack gap="200">
                    {brief.bullets.map((b, i) => (
                      <Text as="p" variant="bodyMd" key={i}>
                        • {b}
                      </Text>
                    ))}
                  </BlockStack>
                ) : null}
                {brief.aiFallbackReason ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Showing VedaSuite's own summary — the explanation service was unavailable.
                  </Text>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {/* ---- Summary, with no cross-currency/period totals ----------- */}
        {summary ? (
          <Layout.Section>
            <Card padding="400">
              <BlockStack gap="300">
                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Open findings</Text>
                    <Text as="p" variant="headingLg">{summary.totalOpen}</Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Critical / high</Text>
                    <Text as="p" variant="headingLg">
                      {summary.bySeverity.critical + summary.bySeverity.high}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Not quantified</Text>
                    <Text as="p" variant="headingLg">{summary.notQuantifiedCount}</Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Limited by data</Text>
                    <Text as="p" variant="headingLg">{summary.incompleteDataCount}</Text>
                  </BlockStack>
                </InlineGrid>

                {summary.quantifiedImpact.length > 0 ? (
                  <BlockStack gap="200">
                    <Divider />
                    <Text as="p" variant="bodySm" tone="subdued">
                      Estimated impact, grouped by currency and period. Figures from different
                      periods or currencies are never added together.
                    </Text>
                    {summary.quantifiedImpact.map((g) => (
                      <Text as="p" variant="bodyMd" key={`${g.currency}-${g.period}`}>
                        {g.min}–{g.max} {g.currency} · {PERIOD_LABEL[g.period] ?? g.period} ·{" "}
                        {g.findingCount} finding{g.findingCount === 1 ? "" : "s"}
                      </Text>
                    ))}
                  </BlockStack>
                ) : null}

                {summary.staleCount > 0 ? (
                  <Banner tone="warning" title="Some findings may be stale">
                    <Text as="p">
                      {summary.staleCount} finding{summary.staleCount === 1 ? "" : "s"} have not been
                      re-confirmed recently. Run Sync Data to refresh.
                    </Text>
                  </Banner>
                ) : null}

                {summary.degradedCount > 0 ? (
                  <Banner tone="warning" title="Some finding details could not be read">
                    <Text as="p">
                      {summary.degradedCount} finding{summary.degradedCount === 1 ? "" : "s"} are
                      shown with limited information because their stored details were unreadable.
                      Run Sync Data to regenerate them.
                    </Text>
                  </Banner>
                ) : null}

                {summary.capReached ? (
                  <Banner tone="info" title="Showing the most recent findings">
                    <Text as="p">
                      This store has a large number of findings. The most recent are shown; the
                      counts above cover everything VedaSuite has recorded.
                    </Text>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {/* ---- Filters ------------------------------------------------- */}
        <Layout.Section>
          <Card padding="300">
            <InlineStack gap="300" wrap>
              <Select
                label="Status"
                labelInline
                options={[
                  { label: "Open", value: "open" },
                  { label: "All", value: "all" },
                  ...(data?.meta.availableStatuses ?? []).map((s) => ({
                    label: STATUS_LABEL[s] ?? s,
                    value: s,
                  })),
                ]}
                value={statusFilter}
                onChange={setStatusFilter}
              />
              <Select
                label="Severity"
                labelInline
                options={[
                  { label: "All", value: "all" },
                  { label: "Critical", value: "critical" },
                  { label: "High", value: "high" },
                  { label: "Medium", value: "medium" },
                  { label: "Low", value: "low" },
                ]}
                value={severityFilter}
                onChange={setSeverityFilter}
              />
            </InlineStack>
          </Card>
        </Layout.Section>

        {/* ---- Empty state --------------------------------------------- */}
        {visibleCards.length === 0 ? (
          <Layout.Section>
            <Card padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Nothing needs your attention right now
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {data?.meta.lastSyncAt
                    ? `VedaSuite last checked your store data on ${formatDate(data.meta.lastSyncAt)}.`
                    : "VedaSuite has not analysed this store yet. Run Sync Data to get started."}
                </Text>
                <InlineStack gap="200">
                  <Button onClick={() => navigateEmbedded("/app/dashboard")}>Go to Store Overview</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {/* ---- Prioritized feed ---------------------------------------- */}
        {visibleCards.map((card) => (
          <Layout.Section key={card.id}>
            <Card padding="400">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="start" wrap={false} gap="200">
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingMd">
                      {card.title}
                    </Text>
                    <InlineStack gap="200" wrap>
                      <Badge tone={SEVERITY_TONE[card.severity]}>{card.severity}</Badge>
                      <Badge>{CONFIDENCE_LABEL[card.confidence]}</Badge>
                      <Badge tone={card.status === "new" ? "attention" : undefined}>
                        {STATUS_LABEL[card.status]}
                      </Badge>
                      {card.degraded ? (
                        <Badge tone="warning">Details unavailable</Badge>
                      ) : !card.dataComplete ? (
                        <Badge tone="warning">Incomplete data</Badge>
                      ) : null}
                      {card.isStale ? <Badge tone="warning">May be stale</Badge> : null}
                    </InlineStack>
                  </BlockStack>
                </InlineStack>

                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">{card.whatHappened}</Text>
                  {card.whyItMatters ? (
                    <Text as="p" variant="bodyMd" tone="subdued">{card.whyItMatters}</Text>
                  ) : null}
                </BlockStack>

                <Text as="p" variant="bodyMd">
                  <strong>Estimated impact:</strong> {impactText(card.impact)}
                </Text>

                <Text as="p" variant="bodyMd">
                  <strong>What to do:</strong> {card.recommendedAction}
                </Text>

                <Text as="p" variant="bodySm" tone="subdued">
                  First seen {formatDate(card.firstDetectedAt)} · last confirmed{" "}
                  {formatDate(card.lastSeenAt)} · detected {card.detectionCount}×
                </Text>

                {/* ---- Evidence / calculation detail ---------------------- */}
                <Button
                  variant="plain"
                  ariaExpanded={expanded === card.id}
                  ariaControls={`evidence-${card.id}`}
                  onClick={() => setExpanded(expanded === card.id ? null : card.id)}
                >
                  {expanded === card.id ? "Hide evidence" : "Show evidence and calculation"}
                </Button>
                <Collapsible open={expanded === card.id} id={`evidence-${card.id}`}>
                  <BlockStack gap="200">
                    <Divider />
                    {card.evidence.length > 0 ? (
                      <BlockStack gap="100">
                        <Text as="h4" variant="headingSm">What proves it</Text>
                        {card.evidence.map((e, i) => (
                          <Text as="p" variant="bodySm" key={i}>
                            {e.label}: {e.value}
                          </Text>
                        ))}
                      </BlockStack>
                    ) : null}

                    {card.impact.status === "quantified" && card.impact.basis ? (
                      <BlockStack gap="100">
                        <Text as="h4" variant="headingSm">How the figure was calculated</Text>
                        <Text as="p" variant="bodySm" tone="subdued">{card.impact.basis}</Text>
                      </BlockStack>
                    ) : card.impact.reason ? (
                      <BlockStack gap="100">
                        <Text as="h4" variant="headingSm">Why there is no figure</Text>
                        <Text as="p" variant="bodySm" tone="subdued">{card.impact.reason}</Text>
                      </BlockStack>
                    ) : null}

                    {card.methodology ? (
                      <BlockStack gap="100">
                        <Text as="h4" variant="headingSm">Method and limits</Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {card.methodology.summary}
                        </Text>
                        {card.methodology.assumptions.map((a, i) => (
                          <Text as="p" variant="bodySm" tone="subdued" key={`a${i}`}>• {a}</Text>
                        ))}
                        {card.methodology.caps.map((c, i) => (
                          <Text as="p" variant="bodySm" tone="subdued" key={`c${i}`}>• {c}</Text>
                        ))}
                      </BlockStack>
                    ) : null}

                    <Text as="p" variant="bodySm" tone="subdued">
                      Priority score {card.rank.score} — from severity, confidence, freshness,
                      impact and data completeness.
                    </Text>
                  </BlockStack>
                </Collapsible>

                <Divider />

                {/* ---- Merchant actions ---------------------------------- */}
                <InlineStack gap="200" wrap>
                  <Button
                    variant="primary"
                    onClick={() => navigateEmbedded(card.route)}
                  >
                    Open details
                  </Button>
                  {card.status === "new" ? (
                    <Button loading={busyId === card.id} onClick={() => act(card, "seen", "seen")}>
                      Mark as seen
                    </Button>
                  ) : null}
                  {card.status !== "in_review" && card.status !== "resolved" ? (
                    <Button
                      loading={busyId === card.id}
                      onClick={() => act(card, "in_review", "in review")}
                    >
                      Start review
                    </Button>
                  ) : null}
                  <Button
                    loading={busyId === card.id}
                    onClick={() => act(card, "resolved", "resolved")}
                  >
                    Resolve
                  </Button>
                  <Button
                    tone="critical"
                    variant="tertiary"
                    loading={busyId === card.id}
                    onClick={() => act(card, "dismissed", "dismissed")}
                  >
                    Dismiss
                  </Button>
                </InlineStack>

                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="span" variant="bodySm" tone="subdued">Was this useful?</Text>
                  <Button variant="plain" onClick={() => sendFeedback(card, true)}>Yes</Button>
                  <Button variant="plain" onClick={() => sendFeedback(card, false)}>No</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ))}
      </Layout>

      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}
