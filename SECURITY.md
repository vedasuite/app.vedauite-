# Security

## Reporting Security Issues

Please do not disclose security vulnerabilities publicly.

Send reports to: `abhimanyu@vedasuite.in`

Include:

- description of the issue
- affected endpoint or module
- reproduction steps
- impact assessment

## Current Security Posture

The app currently includes:

- Shopify OAuth installation flow
- embedded session-token validation for backend API access
- webhook HMAC verification
- request ID tracking for backend errors
- structured JSON event logging

## Recommended Next Improvements

- move compliance export output to durable encrypted storage
- add automated regression tests for auth and webhook verification
- add production alerting on repeated auth and webhook failures
- review scope minimization before production submission
