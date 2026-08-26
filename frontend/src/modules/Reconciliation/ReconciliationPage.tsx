import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Spinner,
  Text,
  Toast,
} from "@shopify/polaris";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";

/**
 * ONE workspace, three checks.
 *
 * The page follows the order a merchant actually works in: pick a check, upload
 * the file, confirm what the columns are, look at what will be imported, then
 * run. Nothing is reconciled until the merchant has seen how many rows are
 * usable and how many are not.
 */

type CheckType = "inventory" | "3pl_invoice" | "supplier_shipment";

const CHECK_LABEL: Record<CheckType, string> = {
  inventory: "Inventory",
  "3pl_invoice": "3PL invoice",
  supplier_shipment: "Supplier shipment",
};

const CHECK_BLURB: Record<CheckType, string> = {
  inventory:
    "Compare the stock levels in Shopify against a stock file from your warehouse or 3PL.",
  "3pl_invoice":
    "Compare a 3PL invoice against your Shopify orders, to see what you are being billed for.",
  supplier_shipment:
    "Compare what a supplier said they shipped against what your records say arrived.",
};

type Suggestion = {
  field: string;
  label: string;
  purpose: string;
  required: boolean;
  suggestedHeader: string | null;
  confidence: "confident" | "uncertain" | "none";
  candidates: string[];
  reason: string;
};

type UploadResult = {
  sourceId: string;
  fileName: string;
  format: string;
  headers: string[];
  sampleRows: string[][];
  suggestions: Suggestion[];
  unmappedHeaders: string[];
  needsConfirmation: boolean;
  totalRows: number;
  truncated: boolean;
};

type MappingPreview = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  truncated: boolean;
  missingOptionalFields: Array<{ field: string; label: string; consequence: string }>;
  invalidExamples: Array<{ rowNumber: number; reason: string }>;
  duplicateExamples: Array<{ rowNumber: number; duplicateOf: number }>;
};

type RunSummary = {
  id: string;
  checkType: CheckType;
  status: string;
  statusReason: string | null;
  matchedCount: number;
  probableCount: number;
  unmatchedCount: number;
  discrepancyCount: number;
  quantifiedCount: number;
  startedAt: string;
  finishedAt: string | null;
};

type Discrepancy = {
  id: string;
  kind: string;
  certainty: "confirmed" | "possible" | "insufficient_data";
  matchConfidence: "exact" | "probable" | "unmatched";
  subjectKey: string;
  shopifyValue: string | null;
  externalValue: string | null;
  difference: number | null;
  impactAmount: number | null;
  impactCurrency: string | null;
  impactBasis: string | null;
  evidence: Array<{ label: string; value: string }>;
};

type Workspace = {
  checkTypes: Array<{
    checkType: CheckType;
    label: string;
    requiredFields: string[];
    optionalFields: string[];
    latestRun: RunSummary | null;
  }>;
  sources: Array<{
    id: string;
    checkType: CheckType;
    fileName: string;
    fileFormat: string;
    status: string;
    statusReason: string | null;
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    uploadedAt: string;
  }>;
  runs: RunSummary[];
  openFindings: number;
  latestRun: RunSummary | null;
  discrepancies: Discrepancy[];
  shopifyReadiness: { variantsWithSku: number; ready: boolean; reason: string | null };
};

/** Certainty drives the badge, so a guess never looks like a fact. */
function certaintyBadge(certainty: Discrepancy["certainty"]) {
  if (certainty === "confirmed") return { tone: "critical" as const, label: "Confirmed" };
  if (certainty === "possible") return { tone: "attention" as const, label: "Possible" };
  return { tone: "info" as const, label: "Insufficient data" };
}

function runStatusBadge(status: string) {
  if (status === "completed") return { tone: "success" as const, label: "Completed" };
  if (status === "completed_with_warnings")
    return { tone: "attention" as const, label: "Completed with warnings" };
  if (status === "failed") return { tone: "critical" as const, label: "Failed" };
  return { tone: "info" as const, label: "Running" };
}

export function ReconciliationPage() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [checkType, setCheckType] = useState<CheckType>("inventory");
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [busy, setBusy] = useState<null | "uploading" | "mapping" | "running">(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The raw file is re-sent when the mapping is confirmed: the backend
  // deliberately does not retain uploaded bytes between requests.
  const fileRef = useRef<{ name: string; base64: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const response = await embeddedShopRequest<{ workspace: Workspace }>(
        "/api/reconciliation/workspace"
      );
      setWorkspace(response.workspace);
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Reconciliation could not be loaded. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const onFileSelected = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setActionError(null);
      setPreview(null);
      setBusy("uploading");
      try {
        const buffer = await file.arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const base64 = btoa(binary);
        fileRef.current = { name: file.name, base64 };

        const response = await embeddedShopRequest<{ result: UploadResult }>(
          "/api/reconciliation/upload",
          {
            method: "POST",
            body: { checkType, fileName: file.name, contentBase64: base64 },
            timeoutMs: 60000,
          }
        );
        setUpload(response.result);
        // Pre-select ONLY the confident suggestions. An uncertain guess is left
        // blank so the merchant has to look at it.
        const initial: Record<string, string> = {};
        for (const suggestion of response.result.suggestions) {
          if (suggestion.confidence === "confident" && suggestion.suggestedHeader) {
            initial[suggestion.field] = suggestion.suggestedHeader;
          }
        }
        setMapping(initial);
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "That file could not be read."
        );
      } finally {
        setBusy(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [checkType]
  );

  const confirmMapping = useCallback(async () => {
    if (!upload || !fileRef.current) return;
    setActionError(null);
    setBusy("mapping");
    try {
      const response = await embeddedShopRequest<{
        result: { preview: MappingPreview };
      }>("/api/reconciliation/mapping", {
        method: "POST",
        body: {
          sourceId: upload.sourceId,
          mapping,
          fileName: fileRef.current.name,
          contentBase64: fileRef.current.base64,
        },
        timeoutMs: 60000,
      });
      setPreview(response.result.preview);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "That mapping could not be applied."
      );
    } finally {
      setBusy(null);
    }
  }, [mapping, upload]);

  const runReconciliation = useCallback(async () => {
    if (!upload) return;
    setActionError(null);
    setBusy("running");
    try {
      const response = await embeddedShopRequest<{
        result: { discrepancyCount: number; status: string; findingsCreated: number };
      }>("/api/reconciliation/run", {
        method: "POST",
        body: { sourceId: upload.sourceId },
        timeoutMs: 120000,
      });
      setToast(
        response.result.discrepancyCount === 0
          ? "Reconciliation completed. Nothing differed between the two sets of records."
          : `Reconciliation completed. ${response.result.discrepancyCount} differences found across ${response.result.findingsCreated} findings.`
      );
      setUpload(null);
      setPreview(null);
      fileRef.current = null;
      await loadWorkspace();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "That reconciliation could not be run."
      );
    } finally {
      setBusy(null);
    }
  }, [loadWorkspace, upload]);

  const requiredUnmapped = useMemo(
    () =>
      (upload?.suggestions ?? []).filter(
        (suggestion) => suggestion.required && !mapping[suggestion.field]
      ),
    [mapping, upload]
  );

  if (loading) {
    return (
      <Page title="Reconciliation">
        <Card>
          <InlineStack gap="200" blockAlign="center">
            <Spinner size="small" />
            <Text as="p">Loading your reconciliation history...</Text>
          </InlineStack>
        </Card>
      </Page>
    );
  }

  const latest = workspace?.latestRun ?? null;

  return (
    <Page
      title="Reconciliation"
      subtitle="Compare Shopify with the files you receive from warehouses, 3PLs and suppliers, and see what does not match."
    >
      <Layout>
        {loadError ? (
          <Layout.Section>
            <Banner tone="critical" title="Reconciliation could not be loaded">
              <p>{loadError}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {workspace && !workspace.shopifyReadiness.ready ? (
          <Layout.Section>
            <Banner tone="warning" title="Your Shopify products have no SKUs yet">
              <p>{workspace.shopifyReadiness.reason}</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {/* ---------------- choose a check ---------------- */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Run a reconciliation
              </Text>
              <InlineStack gap="300" wrap>
                {(Object.keys(CHECK_LABEL) as CheckType[]).map((key) => (
                  <Box
                    key={key}
                    padding="300"
                    borderWidth="025"
                    borderRadius="200"
                    borderColor={key === checkType ? "border-emphasis" : "border"}
                    minWidth="220px"
                  >
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        {CHECK_LABEL[key]}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {CHECK_BLURB[key]}
                      </Text>
                      <Button
                        variant={key === checkType ? "primary" : "secondary"}
                        onClick={() => {
                          setCheckType(key);
                          setUpload(null);
                          setPreview(null);
                          setActionError(null);
                          fileRef.current = null;
                        }}
                      >
                        {key === checkType ? "Selected" : "Choose"}
                      </Button>
                    </BlockStack>
                  </Box>
                ))}
              </InlineStack>

              <Text as="p" variant="bodySm" tone="subdued">
                VedaSuite reads .csv and .xlsx files. It never changes anything in
                Shopify — every reconciliation is read-only.
              </Text>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx"
                onChange={(event) => void onFileSelected(event.target.files?.[0] ?? null)}
                style={{ display: "block" }}
              />
              {busy === "uploading" ? (
                <InlineStack gap="200" blockAlign="center">
                  <Spinner size="small" />
                  <Text as="p">Reading your file...</Text>
                </InlineStack>
              ) : null}
              {actionError ? (
                <Banner tone="critical" title="That did not work">
                  <p>{actionError}</p>
                </Banner>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ---------------- mapping ---------------- */}
        {upload ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Confirm what each column is
                  </Text>
                  <Badge tone="info">{`${upload.totalRows} rows`}</Badge>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {upload.fileName}. VedaSuite pre-selected only the columns it is
                  confident about. Anything it is unsure of is left blank on purpose.
                </Text>
                {upload.truncated ? (
                  <Banner tone="warning">
                    <p>
                      This file is longer than VedaSuite reads in one go. Only the first
                      rows will be reconciled.
                    </p>
                  </Banner>
                ) : null}

                <BlockStack gap="300">
                  {upload.suggestions.map((suggestion) => (
                    <BlockStack gap="100" key={suggestion.field}>
                      <Select
                        label={`${suggestion.label}${suggestion.required ? " (required)" : ""}`}
                        options={[
                          { label: "Not in this file", value: "" },
                          ...upload.headers.map((header) => ({
                            label: header,
                            value: header,
                          })),
                        ]}
                        value={mapping[suggestion.field] ?? ""}
                        onChange={(value) =>
                          setMapping((previous) => ({
                            ...previous,
                            [suggestion.field]: value,
                          }))
                        }
                      />
                      <Text as="p" variant="bodySm" tone="subdued">
                        {suggestion.purpose}
                      </Text>
                      {suggestion.reason ? (
                        <Text as="p" variant="bodySm" tone="caution">
                          {suggestion.reason}
                        </Text>
                      ) : null}
                    </BlockStack>
                  ))}
                </BlockStack>

                {requiredUnmapped.length > 0 ? (
                  <Banner tone="warning">
                    <p>
                      Choose a column for{" "}
                      {requiredUnmapped.map((item) => item.label).join(" and ")} before
                      continuing.
                    </p>
                  </Banner>
                ) : null}

                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    loading={busy === "mapping"}
                    disabled={requiredUnmapped.length > 0 || busy !== null}
                    onClick={() => void confirmMapping()}
                  >
                    Check this file
                  </Button>
                  <Button
                    onClick={() => {
                      setUpload(null);
                      setPreview(null);
                      fileRef.current = null;
                    }}
                  >
                    Cancel
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {/* ---------------- preview before committing ---------------- */}
        {preview ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  What VedaSuite will use
                </Text>
                <InlineStack gap="400" wrap>
                  <Badge tone="success">{`${preview.validRows} usable rows`}</Badge>
                  <Badge tone={preview.invalidRows > 0 ? "attention" : "info"}>
                    {`${preview.invalidRows} unusable`}
                  </Badge>
                  <Badge tone={preview.duplicateRows > 0 ? "attention" : "info"}>
                    {`${preview.duplicateRows} repeated`}
                  </Badge>
                </InlineStack>

                {preview.invalidExamples.length > 0 ? (
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">
                      Rows that cannot be used
                    </Text>
                    <List type="bullet">
                      {preview.invalidExamples.map((example) => (
                        <List.Item key={example.rowNumber}>
                          {`Row ${example.rowNumber}: ${example.reason}`}
                        </List.Item>
                      ))}
                    </List>
                  </BlockStack>
                ) : null}

                {preview.duplicateExamples.length > 0 ? (
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">
                      Repeated rows
                    </Text>
                    <List type="bullet">
                      {preview.duplicateExamples.map((example) => (
                        <List.Item key={example.rowNumber}>
                          {`Row ${example.rowNumber} repeats row ${example.duplicateOf}.`}
                        </List.Item>
                      ))}
                    </List>
                  </BlockStack>
                ) : null}

                {preview.missingOptionalFields.length > 0 ? (
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">
                      What VedaSuite will not be able to tell you
                    </Text>
                    <List type="bullet">
                      {preview.missingOptionalFields.map((field) => (
                        <List.Item key={field.field}>
                          {`No ${field.label} column: ${field.consequence}`}
                        </List.Item>
                      ))}
                    </List>
                  </BlockStack>
                ) : null}

                <Button
                  variant="primary"
                  loading={busy === "running"}
                  disabled={busy !== null || preview.validRows === 0}
                  onClick={() => void runReconciliation()}
                >
                  Reconcile now
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {/* ---------------- latest run ---------------- */}
        {latest ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {`Latest ${CHECK_LABEL[latest.checkType]} reconciliation`}
                  </Text>
                  <Badge tone={runStatusBadge(latest.status).tone}>
                    {runStatusBadge(latest.status).label}
                  </Badge>
                </InlineStack>
                {latest.statusReason ? (
                  <Banner tone="warning" title="This run was not fully conclusive">
                    <p>{latest.statusReason}</p>
                  </Banner>
                ) : null}
                <InlineStack gap="400" wrap>
                  <Badge>{`${latest.matchedCount} matched exactly`}</Badge>
                  <Badge tone={latest.probableCount > 0 ? "attention" : undefined}>
                    {`${latest.probableCount} probable matches`}
                  </Badge>
                  <Badge tone={latest.unmatchedCount > 0 ? "attention" : undefined}>
                    {`${latest.unmatchedCount} unmatched`}
                  </Badge>
                  <Badge tone={latest.discrepancyCount > 0 ? "critical" : "success"}>
                    {`${latest.discrepancyCount} differences`}
                  </Badge>
                  <Badge tone="info">
                    {`${latest.quantifiedCount} valued in money`}
                  </Badge>
                </InlineStack>
                {latest.quantifiedCount < latest.discrepancyCount ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`${latest.discrepancyCount - latest.quantifiedCount} of these have no
                    value attached, because VedaSuite has no cost or reference rate it can
                    defend for them.`}
                  </Text>
                ) : null}
                {workspace && workspace.openFindings > 0 ? (
                  <Text as="p">
                    {`${workspace.openFindings} open reconciliation findings are waiting in the Action Center.`}
                  </Text>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {/* ---------------- discrepancies ---------------- */}
        {workspace && workspace.discrepancies.length > 0 ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  What differed
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={["Subject", "Certainty", "Shopify", "Your file", "Value"]}
                  rows={workspace.discrepancies.map((discrepancy) => [
                    discrepancy.subjectKey,
                    certaintyBadge(discrepancy.certainty).label,
                    discrepancy.shopifyValue ?? "—",
                    discrepancy.externalValue ?? "—",
                    discrepancy.impactAmount != null
                      ? `${discrepancy.impactCurrency ?? ""} ${discrepancy.impactAmount}`.trim()
                      : "Not quantified",
                  ])}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  VedaSuite reports where the two records differ. It does not determine
                  why they differ, and it has not changed anything in Shopify.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {/* ---------------- history ---------------- */}
        {workspace && workspace.runs.length > 0 ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  History
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "numeric", "text"]}
                  headings={["Check", "Status", "Differences", "Valued", "Started"]}
                  rows={workspace.runs.map((run) => [
                    CHECK_LABEL[run.checkType],
                    runStatusBadge(run.status).label,
                    String(run.discrepancyCount),
                    String(run.quantifiedCount),
                    new Date(run.startedAt).toLocaleString(),
                  ])}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}
      </Layout>

      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}
