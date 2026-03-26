import { Router } from "express";
import { env } from "../config/env";

export const publicRouter = Router();

function renderPage(title: string, description: string, body: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <style>
      body { font-family: Georgia, serif; margin: 0; background: #f7f1e7; color: #1e1f27; }
      main { max-width: 860px; margin: 0 auto; padding: 56px 24px 80px; }
      h1 { font-size: 40px; margin-bottom: 8px; }
      h2 { margin-top: 32px; font-size: 24px; }
      h3 { margin-top: 24px; font-size: 18px; }
      p, li { line-height: 1.7; font-size: 16px; }
      .eyebrow { color: #7d5a1c; letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px; }
      .card { background: white; border-radius: 20px; padding: 28px; box-shadow: 0 10px 30px rgba(31, 33, 39, 0.08); margin-top: 24px; }
      a { color: #214f90; }
      code { background: #f0eadf; padding: 2px 6px; border-radius: 6px; }
      .meta { color: #665e52; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">VedaSuite AI</div>
      ${body}
    </main>
  </body>
</html>`;
}

publicRouter.get("/legal/privacy", (_req, res) => {
  res.type("html").send(
    renderPage(
      "VedaSuite AI Privacy Policy",
      "Privacy policy for VedaSuite AI.",
      `
        <h1>Privacy Policy</h1>
        <p class="meta">Last updated: 2026-03-24</p>
        <div class="card">
          <p>VedaSuite AI provides commerce intelligence for Shopify merchants including fraud support, pricing intelligence, competitor monitoring, shopper trust scoring, and profit optimization.</p>
          <h2>Data We Process</h2>
          <p>Depending on merchant configuration and scopes, we may process store metadata, order and customer records, refund behavior, fraud-related signals, merchant-defined settings, and tracked competitor domains.</p>
          <h2>Shared Fraud Intelligence</h2>
          <p>If a merchant explicitly enables shared fraud intelligence, VedaSuite AI limits that behavior to anonymized or pseudonymized fraud signals intended to reduce fraud and return abuse risk. Raw customer contact data is not exposed cross-merchant through this feature.</p>
          <h3>Categories of Data</h3>
          <ul>
            <li>merchant account and store installation information</li>
            <li>order, refund, fulfillment, and product records made available by Shopify</li>
            <li>customer identifiers and contact details required to power merchant workflows</li>
            <li>merchant-entered configuration settings and competitor tracking inputs</li>
            <li>security, diagnostics, audit, and support-related logs</li>
          </ul>
          <h2>Purpose of Processing</h2>
          <p>We process data to operate the app, generate merchant insights, support billing, respond to support and compliance requests, and improve reliability and security.</p>
          <h2>Lawful and Operational Basis</h2>
          <p>Where applicable, we process data to provide the service requested by the merchant, meet platform and legal obligations, protect the service against fraud or abuse, and pursue legitimate operational interests such as reliability, security, and support.</p>
          <h2>Subprocessors and Service Providers</h2>
          <p>Data may be processed by infrastructure, hosting, storage, monitoring, analytics, communication, and support vendors acting on our behalf and under appropriate contractual or operational safeguards.</p>
          <h2>International Transfers</h2>
          <p>Data may be processed in jurisdictions other than the merchant's location. Where required, we rely on reasonable contractual, technical, and organizational measures to protect transferred data.</p>
          <h2>Retention and Compliance</h2>
          <p>We retain data only as needed to provide the service and satisfy legal or platform obligations. VedaSuite AI supports Shopify compliance flows for <code>customers/data_request</code>, <code>customers/redact</code>, and <code>shop/redact</code>.</p>
          <h2>Security</h2>
          <p>We use reasonable administrative, technical, and organizational controls to protect data. No method of storage, processing, or transmission is guaranteed to be completely secure.</p>
          <h2>Merchant and Data Subject Rights</h2>
          <p>Merchants may contact us regarding access, correction, deletion, portability, or objection requests that relate to data processed through the app. We will respond as required by law and Shopify platform obligations.</p>
          <h2>Children's Data</h2>
          <p>VedaSuite AI is intended for business use by merchants and is not directed to children.</p>
          <h2>Policy Updates</h2>
          <p>We may update this policy from time to time to reflect operational, legal, or product changes. Material updates will be reflected by the updated date on this page.</p>
          <h2>Contact</h2>
          <p>Privacy requests can be sent to <a href="mailto:${env.publicContact.privacyEmail}">${env.publicContact.privacyEmail}</a>.</p>
        </div>
      `
    )
  );
});

publicRouter.get("/legal/terms", (_req, res) => {
  res.type("html").send(
    renderPage(
      "VedaSuite AI Terms of Service",
      "Terms of service for VedaSuite AI.",
      `
        <h1>Terms of Service</h1>
        <p class="meta">Last updated: 2026-03-24</p>
        <div class="card">
          <p>VedaSuite AI is a Shopify app that provides merchant decision-support tooling for fraud intelligence, competitor monitoring, pricing guidance, shopper trust scoring, and profit optimization.</p>
          <h2>Acceptance and Eligibility</h2>
          <p>By installing or using VedaSuite AI, the merchant agrees to these terms and represents that they have authority to bind the relevant business or store.</p>
          <h2>Merchant Responsibilities</h2>
          <p>Merchants are responsible for reviewing AI-generated guidance before acting on it and for ensuring their own legal and commercial compliance.</p>
          <h2>Acceptable Use</h2>
          <p>Merchants may not use the service in a way that violates law, infringes rights, interferes with platform integrity, or attempts to reverse engineer, disrupt, or abuse the service.</p>
          <h2>Merchant Review Obligations</h2>
          <p>Merchants remain responsible for reviewing operational recommendations before taking action, especially in areas such as fraud review, refunds, returns, pricing updates, and customer-facing decisions.</p>
          <h2>Billing</h2>
          <p>Paid plans are managed through Shopify Billing and are subject to the plan details shown inside the app and Shopify's billing platform behavior.</p>
          <h2>Intellectual Property</h2>
          <p>VedaSuite AI and its related software, branding, reports, and materials remain the property of VedaSuite AI or its licensors, except for merchant data and merchant-owned content.</p>
          <h2>No Professional Advice</h2>
          <p>App outputs are operational recommendations only and do not constitute legal, tax, financial, or compliance advice.</p>
          <h2>Service Changes and Availability</h2>
          <p>We may update, enhance, suspend, or discontinue all or part of the service from time to time for maintenance, reliability, security, legal compliance, or product evolution.</p>
          <h2>Disclaimer and Limitation of Liability</h2>
          <p>To the maximum extent permitted by law, the service is provided on an as-available and as-offered basis, without guarantees of uninterrupted, error-free, or outcome-specific performance.</p>
          <h2>Termination</h2>
          <p>These terms terminate when the merchant uninstalls the app or when either party terminates access as permitted by law, platform policy, or these terms.</p>
          <h2>Governing Principles</h2>
          <p>These terms should be interpreted under applicable law and platform requirements. If a provision is unenforceable, the remaining provisions continue in effect to the maximum extent allowed.</p>
          <h2>Contact</h2>
          <p>Questions can be sent to <a href="mailto:${env.publicContact.legalEmail}">${env.publicContact.legalEmail}</a>.</p>
        </div>
      `
    )
  );
});

publicRouter.get("/support", (_req, res) => {
  res.type("html").send(
    renderPage(
      "VedaSuite AI Support",
      "Support information for VedaSuite AI.",
      `
        <h1>Support</h1>
        <p>Operational support for VedaSuite AI.</p>
        <div class="card">
          <h2>Contact</h2>
          <p>Email: <a href="mailto:${env.publicContact.supportEmail}">${env.publicContact.supportEmail}</a></p>
          <p>Privacy: <a href="mailto:${env.publicContact.privacyEmail}">${env.publicContact.privacyEmail}</a></p>
          <p>Security: <a href="mailto:${env.publicContact.securityEmail}">${env.publicContact.securityEmail}</a></p>
          <h2>Include in Support Requests</h2>
          <ul>
            <li>Store domain</li>
            <li>Timestamp of the issue</li>
            <li>Request ID if shown in an error response</li>
            <li>Screenshot or screen recording</li>
            <li>The module and action being attempted</li>
          </ul>
        </div>
      `
    )
  );
});

publicRouter.get("/launch/readiness", (_req, res) => {
  res.json({
    app: "VedaSuite AI",
    generatedAt: new Date().toISOString(),
    publicUrls: {
      support: env.publicContact.supportUrl,
      privacy: env.publicContact.privacyUrl,
      terms: env.publicContact.termsUrl,
    },
    complianceExportDir: env.complianceExportDir,
    remainingExternalActions: [
      "Complete protected customer data declarations in Shopify Partner Dashboard",
      "Upload final app icon, screenshots, and review/demo video",
      "Run final production-app install, billing, uninstall, and webhook replay QA",
    ],
  });
});
