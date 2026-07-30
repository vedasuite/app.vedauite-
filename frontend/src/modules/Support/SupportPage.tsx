import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Link,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
  Toast,
} from "@shopify/polaris";
import { useCallback, useEffect, useState } from "react";
import { embeddedShopRequest } from "../../lib/embeddedShopRequest";

// Matches env.publicContact.supportEmail on the backend. Used only for the
// optional "email us directly" convenience link; the primary channel is tickets.
const SUPPORT_EMAIL = "abhimanyu@vedasuite.in";

type Ticket = {
  id: string;
  subject: string;
  category: string;
  message: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | string;
  adminResponse: string | null;
  respondedAt: string | null;
  createdAt: string;
};

const CATEGORY_OPTIONS = [
  { label: "General question", value: "general" },
  { label: "Billing", value: "billing" },
  { label: "Technical issue", value: "technical" },
  { label: "Bug report", value: "bug" },
  { label: "Feature request", value: "feature_request" },
];

function statusBadge(status: string) {
  if (status === "RESOLVED") return <Badge tone="success">Resolved</Badge>;
  if (status === "IN_PROGRESS") return <Badge tone="info">In progress</Badge>;
  return <Badge tone="attention">Open</Badge>;
}

function categoryLabel(value: string) {
  return CATEGORY_OPTIONS.find((c) => c.value === value)?.label ?? value;
}

export function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [category, setCategory] = useState("general");
  const [subject, setSubject] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadTickets = useCallback(async () => {
    try {
      const res = await embeddedShopRequest<{ tickets: Ticket[] }>(
        "/api/support/tickets",
        { timeoutMs: 20000 }
      );
      setTickets(res.tickets ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load your support tickets."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const submit = useCallback(async () => {
    setFormError(null);
    if (!subject.trim()) {
      setFormError("Please add a subject.");
      return;
    }
    if (!message.trim()) {
      setFormError("Please describe your question or issue.");
      return;
    }
    setSubmitting(true);
    try {
      await embeddedShopRequest("/api/support/tickets", {
        method: "POST",
        body: {
          subject: subject.trim(),
          message: message.trim(),
          category,
          contactEmail: contactEmail.trim() || undefined,
        },
      });
      setSubject("");
      setMessage("");
      setContactEmail("");
      setCategory("general");
      setToast("Support request sent. We'll get back to you here.");
      await loadTickets();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Could not send your request. Please retry."
      );
    } finally {
      setSubmitting(false);
    }
  }, [subject, message, category, contactEmail, loadTickets]);

  const mailtoHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    "VedaSuite support request"
  )}`;

  return (
    <Page
      title="Support"
      subtitle="Ask a question or report an issue. We reply right here in the app."
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Contact support
              </Text>

              {formError ? (
                <Banner tone="critical" title="Please check your request">
                  <p>{formError}</p>
                </Banner>
              ) : null}

              <Select
                label="Category"
                options={CATEGORY_OPTIONS}
                value={category}
                onChange={setCategory}
              />
              <TextField
                label="Subject"
                value={subject}
                onChange={setSubject}
                autoComplete="off"
                maxLength={150}
                placeholder="Short summary of your question"
              />
              <TextField
                label="Contact email (optional)"
                value={contactEmail}
                onChange={setContactEmail}
                autoComplete="email"
                type="email"
                helpText="Add an email if you'd prefer a reply there too. Otherwise we reply in this tab."
              />
              <TextField
                label="Message"
                value={message}
                onChange={setMessage}
                autoComplete="off"
                multiline={5}
                maxLength={4000}
                placeholder="Describe your question, issue, or request in detail."
              />
              <InlineStack align="space-between" blockAlign="center">
                <Text as="span" tone="subdued" variant="bodySm">
                  Prefer email? <Link url={mailtoHref} external>Email us directly</Link>
                </Text>
                <Button variant="primary" onClick={submit} loading={submitting}>
                  Send request
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Your requests
              </Text>

              {loading ? (
                <InlineStack align="center">
                  <Spinner accessibilityLabel="Loading tickets" size="small" />
                </InlineStack>
              ) : loadError ? (
                <Banner tone="warning" title="Could not load your requests">
                  <p>{loadError}</p>
                  <Button onClick={() => void loadTickets()}>Try again</Button>
                </Banner>
              ) : tickets.length === 0 ? (
                <Text as="p" tone="subdued">
                  You haven't sent any support requests yet. Use the form above to
                  get in touch.
                </Text>
              ) : (
                <BlockStack gap="300">
                  {tickets.map((t) => (
                    <Card key={t.id} background="bg-surface-secondary">
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingSm">
                            {t.subject}
                          </Text>
                          {statusBadge(t.status)}
                        </InlineStack>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {categoryLabel(t.category)} ·{" "}
                          {new Date(t.createdAt).toLocaleDateString()}
                        </Text>
                        <Text as="p" variant="bodySm">
                          {t.message}
                        </Text>
                        {t.adminResponse ? (
                          <Banner tone="info" title="VedaSuite support replied">
                            <p>{t.adminResponse}</p>
                          </Banner>
                        ) : null}
                      </BlockStack>
                    </Card>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {toast ? <Toast content={toast} onDismiss={() => setToast(null)} /> : null}
    </Page>
  );
}
