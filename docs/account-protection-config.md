# Account Protection Phase A configuration

Account Protection is enabled by default. Set `ACCOUNT_PROTECTION_ENABLED=false` only for a controlled local diagnosis. Protected publishing and account actions should remain enabled in deployed environments.

## Browser profiles

Persistent Playwright browser data is stored per account below `.sns-studio-data/browser-profiles` by default. Set `BROWSER_PROFILE_ROOT` to an access-controlled local volume when the application runs in a container or on a managed host. Do not share this directory between accounts, workers, or environments. Treat it as sensitive session data; limit filesystem access and back it up only under the organization's session-data policy. The implementation does not alter browser fingerprints or use stealth plugins.

## Local encrypted secret store

`LocalEncryptedSecretStore` requires `ACCOUNT_SECRET_ENCRYPTION_KEY` to be a canonical Base64 encoding of 32 random bytes. Keep the key in the deployment secret manager, separate from the secret-store file. Configure `ACCOUNT_SECRET_STORE_PATH` or `SNS_STUDIO_DATA_DIR` to a private persistent directory. The store fails closed when the key is absent or malformed. Losing the key makes stored values unrecoverable; rotate by re-encrypting each secret with a new key before retiring the old key.

The local encrypted store is a Phase A adapter, not a substitute for a managed production secret manager. Restrict host access, filesystem permissions, backups, and operator access accordingly.

## OpenTelemetry

Telemetry is disabled unless `OTEL_ENABLED=true`. When enabled outside tests, configure `OTEL_EXPORTER_OTLP_ENDPOINT` to the trusted OTLP HTTP collector base URL (for example `https://otel.example.invalid`); the service appends `/v1/metrics` and `/v1/traces`. The application emits bounded provider/action/outcome attributes and does not attach account IDs, post content, provider settings, headers, cookies, tokens, session values, or audit metadata. Without an endpoint, telemetry startup logs a generic warning and no exporter is started. Tests can use in-memory metric and span exporters.

## Legacy plaintext provider credentials

**LEGACY_SECRET_STORAGE_FOUND — FOLLOW_UP_SECURITY_MIGRATION_REQUIRED.** The existing `Integration.token` and `Integration.refreshToken` columns store provider credentials as ordinary database strings (and provider-specific `additionalSettings` must be reviewed for embedded credentials). Phase A deliberately does not rewrite those records.

Recommended follow-up migration, once an external secret-store adapter and operational key ownership are approved:

1. Inventory `Integration.token`, `refreshToken`, and `additionalSettings` by provider without logging values; identify additional credential-bearing fields.
2. Back up the database and verify secret-store encryption keys, access controls, restore procedures, and audit logging.
3. Migrate one test account at a time into the approved secret store, storing only opaque `secretRef` values in application records. Preserve the source record until decryption and provider authentication have been verified.
4. Deploy dual-read compatibility (reference first, legacy field only as a temporary fallback) and write-through to the secret store. Emit only migration status, never values.
5. Measure completion without exposing credentials, migrate remaining accounts in batches, then make secret-reference reads mandatory and clear legacy columns after a retention/rollback window.
6. Verify all supported provider flows, backups, deletion, and rollback before removing fallback code. Rotate provider credentials if any historical exposure is confirmed.

Do not start this migration until the production secret manager and rollback owner are defined. Never copy production credentials into the E2E fixtures or repository.

## Historical repository credential exposure

**LEGACY_REPOSITORY_SECRET_EXPOSURE** is tracked separately from Account Protection behavior. Gitleaks found potentially real credentials in repository history; values are intentionally omitted.

- Cloudflare credential history: `.env.example` (historical findings at commits `4552f88950739e776786c38be335f5445c3e7f84` and `6224634dcb125d08651d8b5217c3881b90a9323d`) and `apps/docs/installation/development.mdx` (historical finding at `75648cd90bd8748e0a091b6bf52942d91c159c96`). Current tree: sanitized or absent.
- Sonar token history: `sonar-project.properties` (historical finding at `313830806627da9d4df541cc97945512f5175cec`). Current tree has no `sonar.token`.
- Cloudflare credential rotation status: `OPERATOR_CONFIRMATION_REQUIRED`.
- Sonar credential rotation status: `OPERATOR_CONFIRMATION_REQUIRED`.
- History rewrite status: `NOT_PERFORMED`. Any history rewrite must be evaluated separately after operators confirm credential rotation, with coordination across active branches.

The PR Security Gate blocks exact PR-introduced and current-tree true or unreviewed findings. The Historical Audit continues to report historical exposure but does not fail this PR solely for the explicitly tracked findings above. Baseline classifications are limited to exact commit/path/rule/line fingerprints or an exact current file blob SHA plus path/rule/line. No Gitleaks rules, history scans, or broad path categories are disabled.
