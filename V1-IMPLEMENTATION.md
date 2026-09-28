# V1 implementation status

Baseline: `802f65aca2817bf2a8c30c6fa2911d54957fafba`. This is a change to the existing repository, not a replacement repository.

## Status

Audit, persistence, rules and the OpenAI adapter are implemented locally. The owner explicitly approved the specified OpenAI data transfer. Nothing has been deployed, and none of the 14 real-world acceptance cases is marked passed. An API key and explicit daily call budget are still required; the default budget is zero. Do not release this as the completed V1 before live acceptance.

## Existing deployment audited

Render uses main, `npm install`, `npm start`, a Free Node service in Oregon. The live commit matches the baseline. Supabase project qingqin-family is on Free/Nano in ap-southeast-1. The existing family_links has id bigint primary key, created_at timestamptz, parent_line_user_id and child_line_user_id text with individual unique constraints. RLS is enabled; one family exists. No private IDs or secret values were read out for the audit. Render has DATABASE_URL, DEMO_MODE, LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET; no AI key was listed.

## Architecture and retention

- Keep the Express webhook, raw-body HMAC signature, parent/child confirmation commands and LINE endpoints. Move workflow code into small modules for isolated tests.
- `family_links`: existing rows preserved. revoked_at stops access immediately. Partial unique indexes constrain active parent/child roles. Worker serialization and membership checks also prohibit cross-role reuse. Re-pairing starts a new relationship; old conversations are not attached.
- `care_profiles`: nickname/chat_style columns plus topics/interests/background/avoid_topics arrays. Only the signed, currently paired child can change these fields; either participant may review them.
- `care_tasks`: up to 3 open tasks, 7-day expiry, pending/asked/answered/cancelled state. At most one task introduced per 24 hours, no consecutive questions, avoid_topics respected. AI can select only an eligible task, and mark only a previously asked task answered.
- `messages`: family, speaker, text, event and timestamp. 30-day expiry; at most the last 20 messages within 14 days are used as context. Full LINE IDs are not copied into this table.
- `radar_events`: green/yellow/red, category, first/last evidence, reported duration, bounded evidence dates, notification state. Resolve after 14 days without evidence; expire 90 days after last evidence. Single ordinary sentences do not push. Red means human confirmation, never diagnosis.
- `pairing_requests`: 6-digit code, original 10-minute deadline; persisted through restarts. `pairing_limits`: hash of actor, 10 attempts/10 minutes, expires within 24 hours.
- `ai_usage`: global calls per Taiwan calendar day, retained 90 days. Reserve each call in a separate committed connection before the request, so workflow rollback does not refund a call. An unset/zero cap makes no requests. At most 30 conversational AI calls per family per rolling 24 hours; commands never need AI.
- `webhook_inbox`: only acknowledge after commit; unique event IDs suppress duplicates. Completed payload and source are cleared; idempotency tombstone retained 7 days. Unprocessed payloads expire after 24 hours.
- `notification_outbox`: persisted reply/push jobs, fixed UUID retry key, expiry before LINE's 24-hour key window. Clear destination/content after terminal state; retain status 30 days. Cooldown starts only after LINE accepts a push. Same event defaults to 24-hour reminders with new evidence; family cooldown is 1 hour. Red escalation can bypass cooldown.
- Unlink is a soft revoke, not immediate cascading deletion. Pending jobs are cancelled atomically. Retired relationship data is purged after a 30-day grace period; standard message expiry can occur sooner. Backups follow the provider's separate retention policy.
- All application tables enable RLS and revoke anon/authenticated table grants. No public family query API. Use a server-only DATABASE_URL role. Direct service-role or owner credentials must never enter a client.
- PostgreSQL advisory transaction lock serializes closed-test workflow mutations and sends. Network requests are bounded. This deliberately favors correctness for a small pilot over throughput. PGlite tests do not establish real concurrent PostgreSQL lock behavior.

## Environment

Existing LINE secrets and DATABASE_URL stay in Render. New optional DATABASE_CA_CERT contains the database CA PEM if needed. TLS verification is always enabled on Render. DB_LOCAL_TEST=true is only for an isolated local database, never production. DEMO_MODE is obsolete. New OPENAI_API_KEY is entered directly in Render by the owner, OPENAI_MODEL is gpt-4o-mini, and OPENAI_DAILY_CALL_LIMIT defaults to zero until the owner chooses a cap. No key is requested in chat. Limits constrain calls, not a guaranteed dollar amount.

The AI adapter sends only the current text (at most 1,000 characters), up to 12 history messages of at most 250 characters each, bounded profile fields, event categories/times and eligible tasks. It does not send LINE source IDs, reply tokens or environment secrets. The Responses request uses store:false and strict JSON schema, a 15-second timeout and at most 600 output tokens. Invalid/refused/failed outputs return local fallback. Selected unsafe or forbidden replies are filtered, but this is not a complete guarantee of model behavior; live conversation tests are mandatory.

## Migration and deployment gate

1. Keep OPENAI_DAILY_CALL_LIMIT at 0 (also the default when absent). The owner has requested free operation; AI spending is not authorized. The key has been set directly in Render. Deploy rules-only first; live AI acceptance remains pending explicit spending approval.
2. Run `npm install`, `npm test`; review the full diff and repeat the secret scan.
3. Before production migration, verify there is no cross-role membership collision and ensure the runtime database role can run the additive migration. Existing parent/child individual uniqueness was verified; cross-role collision is still a deployment preflight.
4. `npm run migrate` or startup performs transaction-protected migration version 1. The SQL itself is repeatable. Failed migration fails startup rather than running with partial state.
5. Deploy to the same Render service, verify health and real LINE behavior. Enable LINE webhook redelivery if not already enabled.
6. Test A/B commands, inspect only aggregate database state, restart twice, and confirm actual receipt on B. These require the user's LINE accounts.

**Rollback limitation:** The pre-V1 server does not filter revoked_at and must not be deployed against retained revoked rows. Do not roll back blindly to the old commit. Stop processing and repair/roll forward with a reviewed compatibility patch. No automated destructive down-migration is provided.

## Remaining checks

- External AI schema, output safety, latency, task scheduling and conversational quality.
- Real PostgreSQL role permissions, advisory locks and certificate chain.
- Real push/reply acceptance and user-observed delivery. A LINE API success alone does not prove B read or received a visible notification.
- Offline retry, cold-start delay and reply-token expiry on Render Free. A stale reply is cancelled; it is not silently converted to a billable push.
- All 14 requested acceptance tests, including two deploy/restart cycles.

## Cost drivers (usage model, not a quote)

Assume each family sends 10 parent messages/day, 30 days/month, one AI request/turn with 2,000 input and 300 output tokens:

| Families | AI calls/month | Input tokens/month | Output tokens/month | Radar pushes at 1/family/week |
|---:|---:|---:|---:|---:|
| 10 | 3,000 | 6 million | 0.9 million | about 43 |
| 100 | 30,000 | 60 million | 9 million | about 430 |
| 1,000 | 300,000 | 600 million | 90 million | about 4,300 |

Main costs: model input/output, LINE billable pushes and account plan, an always-on Render instance when Free delays become unacceptable, Supabase storage/backups/connections. The table excludes pairing/status pushes and retries. Actual cost depends on model/account pricing and usage. This globally serialized pilot architecture is not validated for 1,000 families; it is a cost illustration, not a capacity promise.

LINE reference: https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
OpenAI documentation reviewed for the proposed adapter: https://developers.openai.com/api/docs/guides/structured-outputs and https://developers.openai.com/api/docs/guides/your-data . `store:false` does not imply zero abuse-monitoring retention.
