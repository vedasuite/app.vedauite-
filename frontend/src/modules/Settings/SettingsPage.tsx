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
import { useEmbeddedNavigation } from "../../hooks/useEmbeddedNavigation";
import { useSubscriptionPlan } from "../../hooks/useSubscriptionPlan";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";

type Settings = {
  fraudSensitivity: "low" | "medium" | "high";
  sharedFraudNetwork: boolean;
  pricingBias: number;
  profitGuardrail: number;
  competitorDomains: { id?: string; domain: string; label?: string | null }[];
};

const fallbackSettings: Settings = {
  fraudSensitivity: "medium",
  sharedFraudNetwork: false,
  pricingBias: 55,
  profitGuardrail: 18,
  competitorDomains: [],
};

export function SettingsPage() {
  const { navigateEmbedded } = useEmbeddedNavigation();
  const { subscription } = useSubscriptionPlan();
  const [settings, setSettings] = useState<Settings>(fallbackSettings);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [hasLiveSettings, setHasLiveSettings] = useState(false);
  const [serviceOffline, setServiceOffline] = useState(false);
  const [domainsInput, setDomainsInput] = useState("");
  const [selectedTab, setSelectedTab] = useState(0);
  const [pricingBias, setPricingBias] = useState(fallbackSettings.pricingBias);
  const [profitGuardrail, setProfitGuardrail] = useState(fallbackSettings.profitGuardrail);
  const [toast, setToast] = useState<string | null>(null);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);

  const pricingProfitEnabled = !!subscription?.enabledModules.pricingProfit;
  const fullProfitEngineEnabled = !!subscription?.featureAccess.fullProfitEngine;
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

  useEffect(() => {
    let mounted = true;
    setSyncing(true);

    embeddedShopRequest<{ settings: Settings }>("/api/settings", {
      timeoutMs: 30000,
    })
      .then((res) => {
        if (!mounted) return;
        setSettings(res.settings);
        setHasLiveSettings(true);
        setServiceOffline(false);
        setPricingBias(res.settings.pricingBias ?? fallbackSettings.pricingBias);
        setProfitGuardrail(
          res.settings.profitGuardrail ?? fallbackSettings.profitGuardrail
        );
        setDomainsInput(
          (res.settings.competitorDomains ?? []).map((domain) => domain.domain).join(", ")
        );
      })
      .catch(() => {
        if (!mounted) return;
        setHasLiveSettings(false);
        setServiceOffline(true);
      })
      .finally(() => {
        if (!mounted) return;
        setSyncing(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const save = async () => {
    const competitorDomains = domainsInput
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean)
      .map((domain) => ({ domain }));

    try {
      setLoading(true);
      setSaveBanner(null);
      const payload = {
        fraudSensitivity: settings.fraudSensitivity,
        sharedFraudNetwork: settings.sharedFraudNetwork,
        pricingBias,
        profitGuardrail,
        competitorDomains,
      };
      const response = await embeddedShopRequest<{ settings: Settings }>("/api/settings", {
        method: "POST",
        body: { settings: payload },
        timeoutMs: 30000,
      });

      setSettings(response.settings);
      setHasLiveSettings(true);
      setServiceOffline(false);
      setDomainsInput(
        (response.settings.competitorDomains ?? []).map((domain) => domain.domain).join(", ")
      );
      setToast("Settings saved.");
      setSaveBanner("Merchant settings updated successfully.");
    } catch {
      setServiceOffline(true);
      setToast("Unable to save settings right now. Your current changes are still visible on this screen.");
    } finally {
      setLoading(false);
    }
  };

  const fraudAutomationPosture =
    settings.sharedFraudNetwork && settings.fraudSensitivity === "high"
      ? "Review-first automation is ready for repeated fraud patterns."
      : settings.sharedFraudNetwork
      ? "Shared network is collecting evidence for stronger fraud rules."
      : "Fraud automation is local-only until shared network is enabled.";

  const pricingAutomationPosture = pricingProfitEnabled
    ? pricingBias >= 70
      ? "Pricing automation should stay approval-led and margin-protective."
      : pricingBias <= 35
      ? "Pricing automation can be more responsive, but still needs merchant guardrails."
      : "Balanced pricing posture is best for controlled approval-led automation."
    : "Pricing & Profit is not active on this plan, so AI pricing controls stay view-only.";
  const activePlanLabel = subscription?.planName ?? "TRIAL";
  const settingsSourceLabel = hasLiveSettings
    ? "Live merchant settings"
    : serviceOffline
    ? "Fallback profile"
    : "Ready-to-edit defaults";

  return (
    <Page
      title="Settings"
      subtitle="Tune detection sensitivity, tracking coverage, and AI operating preferences."
    >
      <Layout>
        <Layout.Section>
          <Banner title="Merchant controls" tone="info">
            <p>
              Settings stay available on every plan. The controls shown here adapt to the modules
              currently enabled for the store.
            </p>
          </Banner>
        </Layout.Section>
        {syncing ? (
          <Layout.Section>
            <Banner title="Refreshing merchant controls" tone="info">
              <p>
                VedaSuite is syncing saved merchant preferences in the background. The page stays usable while live values load.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}
        {serviceOffline ? (
          <Layout.Section>
            <Banner
              title="Using ready-to-edit default controls"
              tone="warning"
              action={{ content: "Refresh settings", onAction: () => window.location.reload() }}
            >
              <p>
                Live merchant settings could not be loaded right now, so this page is using a safe fallback profile.
                You can still review settings structure and retry saving once the service reconnects.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}
        {saveBanner ? (
          <Layout.Section>
            <Banner title="Settings saved" tone="success" onDismiss={() => setSaveBanner(null)}>
              <p>{saveBanner}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 4 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">Active plan</Text>
                  <Badge tone="success">{activePlanLabel}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Settings remain available on every plan and adapt to active modules.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Operating profile: {operatingProfile}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Source: {settingsSourceLabel}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Competitor controls</Text>
                <Badge tone={competitorEnabled ? "success" : "info"}>
                  {competitorEnabled ? "Enabled" : "Visible but inactive"}
                </Badge>
                <Text as="p" variant="bodySm" tone="subdued">
                  Tracked domains: {connectedDomains}
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Pricing controls</Text>
                <Badge tone={pricingProfitEnabled ? "success" : "info"}>
                  {pricingProfitEnabled ? "Enabled" : "Visible but inactive"}
                </Badge>
                <Text as="p" variant="bodySm" tone="subdued">
                  Bias: {pricingBias}/100
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Profit controls</Text>
                <Badge tone={fullProfitEngineEnabled ? "success" : "attention"}>
                  {fullProfitEngineEnabled ? "Enabled" : "Pro-only active"}
                </Badge>
                <Text as="p" variant="bodySm" tone="subdued">
                  Guardrail: {profitGuardrail}%
                </Text>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Risk operations preset</Text>
                <Text as="p" tone="subdued">
                  Higher fraud sensitivity with shared network enabled for stores battling abuse.
                </Text>
                <Button
                  onClick={() =>
                    setSettings((prev) => ({
                      ...prev,
                      fraudSensitivity: "high",
                      sharedFraudNetwork: true,
                    }))
                  }
                >
                  Apply risk preset
                </Button>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">Balanced growth preset</Text>
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
                <Text as="h3" variant="headingMd">Margin protection preset</Text>
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
                { id: "trust", content: "Trust & Abuse" },
                { id: "competitors", content: "Competitors" },
                { id: "pricingProfit", content: "Pricing & Profit" },
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
                      value={settings.fraudSensitivity}
                      onChange={(value) =>
                        setSettings((prev) => ({
                          ...prev,
                          fraudSensitivity: value as Settings["fraudSensitivity"],
                        }))
                      }
                    />
                    <Checkbox
                      label="Join shared fraud intelligence network"
                      checked={settings.sharedFraudNetwork}
                      onChange={(checked) =>
                        setSettings((prev) => ({ ...prev, sharedFraudNetwork: checked }))
                      }
                    />
                    <Text as="p" tone="subdued">
                      {fraudAutomationPosture}
                    </Text>
                  </BlockStack>
                ) : selectedTab === 1 ? (
                  <BlockStack gap="300">
                    {!competitorEnabled ? (
                      <Banner title="Competitor controls are visible but not active on this plan" tone="info">
                        <p>
                          You can prepare tracked domains now. Live competitor monitoring activates once a plan with Competitor Intelligence is active.
                        </p>
                      </Banner>
                    ) : null}
                    <TextField
                      label="Competitor domains"
                      value={domainsInput}
                      onChange={setDomainsInput}
                      autoComplete="off"
                      multiline={4}
                    />
                    <Text as="p" tone="subdued">
                      Add domains separated by commas to monitor websites, promotions, and launch activity.
                    </Text>
                  </BlockStack>
                ) : (
                  <BlockStack gap="400">
                    {!pricingProfitEnabled ? (
                      <Banner title="Pricing & Profit controls are view-only on this plan" tone="warning">
                        <p>
                          This plan can still show the operating profile, but AI pricing changes and profit guardrails activate on Growth and above.
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
                      disabled={!pricingProfitEnabled}
                    />
                    <Text as="p" tone="subdued">
                      {pricingAutomationPosture}
                    </Text>
                    <RangeSlider
                      label="Profit guardrail"
                      value={profitGuardrail}
                      min={5}
                      max={40}
                      onChange={(value) => setProfitGuardrail(Number(value))}
                      output
                      disabled={!fullProfitEngineEnabled}
                    />
                    <Text as="p" tone="subdued">
                      {fullProfitEngineEnabled
                        ? "Advanced profit guardrails are active for this store."
                        : "Full profit guardrails become active on Pro."}
                    </Text>
                    {!pricingProfitEnabled || !fullProfitEngineEnabled ? (
                      <InlineStack>
                        <Button onClick={() => navigateEmbedded("/subscription")}>
                          Review plan access
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
          <Button variant="primary" onClick={save} loading={loading}>
            Save settings
          </Button>
        </Layout.Section>
      </Layout>
      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}
