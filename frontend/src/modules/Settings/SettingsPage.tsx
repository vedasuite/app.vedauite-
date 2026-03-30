import {
  Banner,
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  RangeSlider,
  Select,
  Tabs,
  Text,
  TextField,
  Toast,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { useApiClient } from "../../api/client";
import { LoadingPageState } from "../../components/PageState";
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { withRequestTimeout } from "../../lib/requestTimeout";

type Settings = {
  fraudSensitivity: "low" | "medium" | "high";
  sharedFraudNetwork: boolean;
  pricingBias: number;
  profitGuardrail: number;
  competitorDomains: { id: string; domain: string; label?: string | null }[];
};

const fallbackSettings: Settings = {
  fraudSensitivity: "medium",
  sharedFraudNetwork: false,
  pricingBias: 55,
  profitGuardrail: 18,
  competitorDomains: [],
};

export function SettingsPage() {
  const api = useApiClient();
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { subscription } = useSubscriptionPlan();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [serviceOffline, setServiceOffline] = useState(false);
  const [domainsInput, setDomainsInput] = useState("");
  const [selectedTab, setSelectedTab] = useState(0);
  const [pricingBias, setPricingBias] = useState(55);
  const [profitGuardrail, setProfitGuardrail] = useState(18);
  const [toast, setToast] = useState<string | null>(null);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);
  const pricingEnabled = !!subscription?.enabledModules.pricing;
  const profitEnabled = !!subscription?.enabledModules.profitOptimization;
  const competitorEnabled = !!subscription?.enabledModules.competitor;
  const connectedDomains = domainsInput
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean).length;

  const operatingProfile =
    pricingBias >= 70
      ? "Margin-first"
      : pricingBias <= 35
      ? "Growth-first"
      : "Balanced";
  const fraudAutomationPosture =
    settings?.sharedFraudNetwork && settings.fraudSensitivity === "high"
      ? "Review-first automation is ready for repeated fraud patterns."
      : settings?.sharedFraudNetwork
      ? "Shared network is collecting evidence for stronger fraud rules."
      : "Fraud automation is local-only until shared network is enabled.";
  const pricingAutomationPosture = pricingEnabled
    ? pricingBias >= 70
      ? "Pricing automation should stay approval-led and margin-protective."
      : pricingBias <= 35
      ? "Pricing automation can be more responsive, but still needs merchant guardrails."
      : "Balanced pricing posture is best for controlled approval-led automation."
    : "Unlock pricing strategy to enable pricing automations.";

  useEffect(() => {
    withRequestTimeout(api.get<{ settings: Settings }>("/api/settings"), 20000)
      .then((res) => {
        setSettings(res.data.settings);
        setServiceOffline(false);
        setPricingBias(res.data.settings.pricingBias ?? 55);
        setProfitGuardrail(res.data.settings.profitGuardrail ?? 18);
        setDomainsInput(
          res.data.settings.competitorDomains.map((domain) => domain.domain).join(", ")
        );
      })
      .catch(() => {
        setSettings(fallbackSettings);
        setServiceOffline(true);
        setPricingBias(fallbackSettings.pricingBias);
        setProfitGuardrail(fallbackSettings.profitGuardrail);
        setDomainsInput("");
      })
      .finally(() => {
        setLoading(false);
        setLoadedOnce(true);
      });
  }, [api]);

  const save = async () => {
    if (!settings) return;

    if (serviceOffline) {
      setToast("Settings service is offline right now. Please try again after the next sync.");
      return;
    }

    if (competitorEnabled && connectedDomains === 0) {
      setToast("Add at least one competitor domain before saving competitor tracking.");
      return;
    }

    const competitorDomains = domainsInput
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean)
      .map((domain) => ({ domain }));

    try {
      await api.post("/api/settings", {
        settings: {
          fraudSensitivity: settings.fraudSensitivity,
          sharedFraudNetwork: settings.sharedFraudNetwork,
          pricingBias,
          profitGuardrail,
          competitorDomains,
        },
      });
      setToast("Settings saved.");
      setSaveBanner("Merchant settings updated successfully.");
    } catch {
      setToast("Unable to save settings.");
    }
  };

  if (loading && !loadedOnce) {
    return (
      <LoadingPageState
        title="Settings"
        subtitle="Loading merchant controls..."
        message="Preparing plan-aware settings and saved preferences."
      />
    );
  }

  return (
    <Page
      title="Settings"
      subtitle="Tune detection sensitivity, tracking coverage, and AI operating preferences."
    >
      <Layout>
        <Layout.Section>
          <Banner title="Merchant controls" tone="info">
            <p>
              These controls help merchants adapt VedaSuite to store risk,
              category behavior, and profitability goals.
            </p>
          </Banner>
        </Layout.Section>
        {serviceOffline ? (
          <Layout.Section>
            <Banner
              title="Settings service is temporarily unavailable"
              tone="warning"
              action={{
                content: "Open subscription plans",
                onAction: () => navigateEmbedded("/subscription"),
              }}
            >
              <p>
                You can still review the default operating profile below, but
                saving merchant-specific settings will remain disabled until the
                settings API responds again.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}
        {saveBanner ? (
          <Layout.Section>
            <Banner
              title="Settings saved"
              tone="success"
              onDismiss={() => setSaveBanner(null)}
            >
              <p>{saveBanner}</p>
            </Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    Active plan
                  </Text>
                  <Badge tone="success">{subscription?.planName ?? "TRIAL"}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Settings adapt to the modules enabled on the current subscription.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Operating profile: {operatingProfile}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Pricing controls
                </Text>
                <Badge tone={pricingEnabled ? "success" : "attention"}>
                  {pricingEnabled ? "Enabled" : "Upgrade needed"}
                </Badge>
                <Text as="p" variant="bodySm" tone="subdued">
                  Bias: {pricingBias}/100
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Profit controls
                </Text>
                <Badge tone={profitEnabled ? "success" : "attention"}>
                  {profitEnabled ? "Enabled" : "Upgrade needed"}
                </Badge>
                <Text as="p" variant="bodySm" tone="subdued">
                  Guardrail: {profitGuardrail}%
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Automation posture
                </Text>
                <Badge tone="info">Hardening</Badge>
                <Text as="p" variant="bodySm" tone="subdued">
                  {fraudAutomationPosture}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {pricingAutomationPosture}
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Risk operations preset
                </Text>
                <Text as="p" tone="subdued">
                  Higher fraud sensitivity with shared network enabled for stores battling abuse.
                </Text>
                <Button
                  onClick={() =>
                    setSettings((prev) =>
                      prev
                        ? {
                            ...prev,
                            fraudSensitivity: "high",
                            sharedFraudNetwork: true,
                          }
                        : prev
                    )
                  }
                >
                  Apply risk preset
                </Button>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Balanced growth preset
                </Text>
                <Text as="p" tone="subdued">
                  Balanced pricing bias with moderate guardrails for steady expansion.
                </Text>
                <Button
                  onClick={() => {
                    setPricingBias(55);
                    setProfitGuardrail(18);
                  }}
                >
                  Apply balanced preset
                </Button>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Margin protection preset
                </Text>
                <Text as="p" tone="subdued">
                  Push the AI stack toward profit protection and tighter decision thresholds.
                </Text>
                <Button
                  onClick={() => {
                    setPricingBias(78);
                    setProfitGuardrail(26);
                  }}
                >
                  Apply margin preset
                </Button>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <Tabs
              tabs={[
                { id: "fraud", content: "Fraud" },
                { id: "competitors", content: "Competitors" },
                { id: "ai", content: "AI preferences" },
              ]}
              selected={selectedTab}
              onSelect={setSelectedTab}
            >
              <Box paddingBlockStart="400">
                {selectedTab === 0 ? (
                  <BlockStack gap="300">
                    <Select
                      label="Fraud sensitivity"
                      options={[
                        { label: "Low", value: "low" },
                        { label: "Medium", value: "medium" },
                        { label: "High", value: "high" },
                      ]}
                      value={settings?.fraudSensitivity ?? "medium"}
                      onChange={(value) =>
                        setSettings(
                          (prev) =>
                            prev && {
                              ...prev,
                              fraudSensitivity: value as Settings["fraudSensitivity"],
                            }
                        )
                      }
                    />
                    <Checkbox
                      label="Join shared fraud intelligence network"
                      checked={settings?.sharedFraudNetwork ?? false}
                      onChange={(checked) =>
                        setSettings(
                          (prev) =>
                            prev && { ...prev, sharedFraudNetwork: checked }
                        )
                      }
                    />
                  </BlockStack>
                ) : selectedTab === 1 ? (
                  <BlockStack gap="300">
                    {!competitorEnabled ? (
                      <Banner title="Competitor controls are limited on this plan" tone="info">
                        <p>
                          Upgrade to a plan with Competitor Intelligence to unlock
                          richer tracking workflows and market alerts.
                        </p>
                      </Banner>
                    ) : null}
                    <TextField
                      label="Competitor domains"
                      value={domainsInput}
                      onChange={setDomainsInput}
                      autoComplete="off"
                      multiline={4}
                      disabled={!competitorEnabled}
                    />
                    <Text as="p" tone="subdued">
                      Add domains separated by commas to monitor websites,
                      promotions, and launch activity.
                    </Text>
                    <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                      <div className="vs-signal-stat">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Tracked domains
                        </Text>
                        <Text as="p" variant="headingLg">
                          {connectedDomains}
                        </Text>
                      </div>
                      <div className="vs-signal-stat">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Coverage posture
                        </Text>
                        <Text as="p" variant="headingLg">
                          {connectedDomains >= 3 ? "Broad" : connectedDomains >= 1 ? "Focused" : "None"}
                        </Text>
                      </div>
                      <div className="vs-signal-stat">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Readiness
                        </Text>
                        <Text as="p" variant="headingLg">
                          {connectedDomains > 0 ? "Ready" : "Setup"}
                        </Text>
                      </div>
                    </InlineGrid>
                  </BlockStack>
                ) : (
                  <BlockStack gap="400">
                    {!pricingEnabled || !profitEnabled ? (
                      <Banner title="AI preference controls expand on higher plans" tone="warning">
                        <p>
                          Pricing strategy preferences require Pricing Strategy access,
                          and profit guardrails unlock fully on the Pro plan.
                        </p>
                      </Banner>
                    ) : null}
                    <RangeSlider
                      label="Pricing strategy bias"
                      value={pricingBias}
                      min={0}
                      max={100}
                      onChange={(value) => setPricingBias(Number(value))}
                      output
                      disabled={!pricingEnabled}
                    />
                    <Text as="p" tone="subdued">
                      {pricingBias >= 70
                        ? "The AI will prioritize margin retention over aggressive competitive pricing."
                        : pricingBias <= 35
                        ? "The AI will lean toward faster price response to capture market momentum."
                        : "The AI will balance conversion and margin protection."}
                    </Text>
                    <RangeSlider
                      label="Profit guardrail"
                      value={profitGuardrail}
                      min={5}
                      max={40}
                      onChange={(value) => setProfitGuardrail(Number(value))}
                      output
                      disabled={!profitEnabled}
                    />
                    <Text as="p" tone="subdued">
                      {profitGuardrail >= 25
                        ? "Only high-confidence profit moves will be surfaced."
                        : profitGuardrail <= 12
                        ? "The engine will surface more experimental opportunities."
                        : "The engine will recommend only measured, merchant-friendly optimizations."}
                    </Text>
                    {!pricingEnabled || !profitEnabled ? (
                      <InlineStack>
                        <Button onClick={() => navigateEmbedded("/subscription")}>
                          Upgrade plan
                        </Button>
                      </InlineStack>
                    ) : null}
                  </BlockStack>
                )}
              </Box>
            </Tabs>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Button variant="primary" onClick={save} disabled={serviceOffline}>
            Save settings
          </Button>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}
