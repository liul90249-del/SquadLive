# SquadLive Backend

Minimal backend for local testing and early production wiring.

## Run

```bash
cd Backend
cp .env.example .env
PORT=8787 DEEPSEEK_API_KEY=your_key ADMIN_TOKEN=change-this npm run dev
```

## Main APIs

- `GET /health`
- `POST /v1/users/bootstrap`
- `GET /v1/users/:userId`
- `POST /v1/wallet/balance`
- `POST /v1/ai/deepseek`
- `POST /v1/audience/quote`
- `POST /v1/audience/commit`
- `POST /v1/storekit/coins/claim`
- `POST /v1/storekit/subscriptions/claim`
- `POST /v1/storekit/notifications`
- `POST /v1/rewards/share-submissions`
- `POST /v1/rewards/:submissionId/review`
- `GET /v1/admin/settings`
- `POST /v1/admin/settings`
- `POST /v1/admin/users/:userId`

Coin balances are server-authoritative. Verified purchases, audience spending, daily share rewards, and reviewed bonuses update the backend ledger first. Wallet operation IDs make retries idempotent so the same request cannot charge or reward twice.

The admin dashboard can change the starting balance used for newly created users and can apply audited manual coin adjustments to an existing user. Feedback email generated from the iOS Home Screen shortcut includes both the backend user ID and the device lookup ID; either value can be pasted into the admin user search.

Coin purchase revenue is normalized to USD using the product prices configured by SquadLive (`$4.99`, `$5.99`, `$6.99`, `$8.99`, `$14.99`, and `$19.99`). App Store localized prices such as CNY are not treated as USD, and historical coin records are corrected by product ID when the server starts.

Data is stored in `data/store.json` for local development. Replace this with a real database before production.


## Admin appearance comparison (2026-10-19)

The existing admin now keeps two selectable styles: **A · 经典深色** and
**B · 珍珠玻璃**. Both use the same renderers, authenticated APIs and metric
calculations. Switching style preserves the selected product and loaded/filter
results. Classic remains the default; the browser remembers the selection.
The pearl presentation adds section navigation, scrollable tables and sticky
headers. Metric captions now distinguish today's activity from cumulative counts.

To compare locally without production credentials or data:

```bash
node Backend/scripts/admin-style-preview.mjs
```

Run from the repository root, then open:

- Classic: http://127.0.0.1:8896/admin?style=classic&product=cleaner
- Pearl: http://127.0.0.1:8896/admin?style=pearl&product=cleaner

This preview binds only to loopback, uses explicitly labelled synthetic fixtures,
rejects all non-GET requests, and does not proxy the live service. Its numbers,
prices and retention rates are not operational evidence. It includes Smart
Cleaner, CatSwipe (no purchases) and SquadLive sample states. The preview server
is a development script, not a production entry point.

The visual adaptation is based on scaffold-master's pearl design tokens, with
provenance and MIT license under `vendor/scaffold-master/`. It does not import the
template's Vue/Spring stack, authentication, database or GSAP.

Validation: existing product-operations tests passed (3/3); browser checks covered
style/data parity, product switching, search preservation, empty CatSwipe orders,
and 1440px/390px layouts without page overflow. No production authenticated data,
deployment or client build was changed. Production rollout remains separate.

Product switching also updates the sidebar app icon, favicon and browser title in
both styles. Icons are copied unchanged from each local app asset catalog; source
paths are recorded in `assets/products/sources.json`.


### Data workspace update (2026-10-19)

The B option is now **数据工作台**, not just a color theme. The A option keeps the
classic long-form lists. For products using the product-operations API, B has:

- Separate overview, trend, user, order and observed-price views.
- UTC date ranges (7/14/30 days or custom), preceding-period comparisons, an
  interactive daily chart, currency-specific amounts and drilldown links.
- An attention panel for attribution review/refunds; retention and lifetime
  figures explicitly separated from the selected period.
- Query/status/date filters, sorting, 10-row pagination, read-only detail dialogs
  and a user board grouped by net-paid-order status. This is not a membership
  eligibility view. User-to-order and SKU links use exact identifiers.

The view consumes the same existing protected API response; no new business
endpoint or schema is introduced. SquadLive retains its existing specialized
operations views. Chart history is limited to the API's 30-day window. Daily
active users are averaged, never summed into a purported unique-period count.
Comparisons require a complete preceding date interval; a zero baseline is
labelled as new rather than +100%. The current UTC day may be incomplete. Refund
drilldowns use refund timestamps; unknown refund dates cannot be attributed to a
period. All-currency totals are never combined. Lists operate on the records
returned by the API; pagination is client-side, not a server-wide search.

`admin-insights-core.mjs` contains pure presentation selectors;
`admin-insights.mjs` owns the workspace, filters, charts and dialogs;
`admin-insights.css` owns the workspace layout. `admin.html` publishes a guarded
load snapshot so late responses from another product cannot overwrite the active
view. The template's workspace/list/board patterns inform this implementation;
its identity-management model, drag-to-change privileges and auth are not copied.

Validation: `node --test Backend/tests/admin-insights.test.mjs
Backend/tests/product-operations.test.mjs` passes 7 checks. Browser verification
covers metric/refund drilldowns, user search/pagination/board/detail, exact user
orders, style-switch preservation, date/currency controls, empty CatSwipe orders,
and 1440px/390px page widths. Preview is still synthetic, loopback-only and
read-only; no production deployment or Apple review changes.

Interaction pass: view changes use a short, staggered reveal; list/board and chart
updates use a compact fade. Metric/user cards have hover and press feedback.
Chart points support pointer or Enter/Space selection with a date cursor, tooltip,
synchronized date button and drilldown; selecting a point updates only its detail
region so keyboard focus and the date strip scroll position are retained. Native
modal focus/Escape behavior is preserved with a short entry transition. Reduced
motion disables the JS reveals and CSS motion. No continuous animation loop or
network dependency is added. Verified chart selection → daily order → detail →
Escape, and no browser warnings/errors were observed.

### Smart Cleaner subscription lifecycle (2026-10-20)

The protected product operations response now also contains `subscriptions` for
Cleaner. Both admin styles show a daily table ordered newest first, with 30 more
days loaded on demand through all locally observed history. The existing general
revenue/activity chart still covers 30 days. Counts open read-only identity lists.

- Event-day counts: first observed subscription (including trials), first observed
  subscription payment, and distinct identities with Apple's
  `DID_CHANGE_RENEWAL_STATUS / AUTO_RENEW_DISABLED` notification that day.
- Subscription-date cohorts: later cancellations, currently disabled renewal,
  unknown status, eventual paid conversion. Later evidence recalculates old rows.
  Re-enabling renewal does not erase the historical cancellation metric.
- Registration-date conversion: identities linked to that day's registrations
  that have subscribed / paid, divided by those registrations. Unlinked
  subscriptions are reported separately and excluded from these denominators.
  First payment remains a conversion if subsequently refunded; refunds remain in
  the existing separate order/refund table. Identities are not unique humans.
- A cancellation is renewal disabled, not expiration, refund or immediate loss of
  entitlement. Unknown renewal status yields an unknown cancellation rate. Current
  status queries cannot establish the exact date of past cancellation, so they
  backfill cohort counts without fabricating event-day cancellations. Historical
  notifications before this deployment may be missing; the UI states this limit.

Verified renewal info and notification UUIDs are stored atomically under
`DATA_DIR/partner-inbox/cleaner/<environment>/lifecycle/state.json`, isolated from
receipts and Sandbox. Duplicate notifications are idempotent; older signed renewal
states cannot replace newer states. Inbox and scheduler writes share a per-file
queue. Run a single backend writer for a data directory, as with the existing
JSON store. Keep this persistent directory backed up.

The server checks once per UTC date at **00:00 UTC / 08:00 Asia/Shanghai** (within
the one-minute timer resolution), catches up on startup, prevents overlapping runs
and retries partial/failed runs after 15 minutes. Completed dates persist through
restart. UTC is a consistent reporting day, not every US region's local midnight.
Apple notifications update persisted state upon arrival; the admin's existing
30-second refresh displays changes without a daily wait. A continuously running
backend is required for the scheduled check.

Production activation requires `DATA_DIR`, `CLEANER_APPLE_IAP_KEY_ID`,
`CLEANER_APPLE_IAP_ISSUER_ID`, and `CLEANER_APPLE_IAP_PRIVATE_KEY` (Apple In-App
Purchase API credentials authorised for `com.hecathehe.PhoneCleaner`). No credentials
are sent to the browser or borrowed from another app. The server reads Apple's
Get All Subscription Statuses endpoint for known original subscription IDs and
verifies both signed transaction and renewal payloads plus app/environment identity.
Its notification URL must be configured in App Store Connect as
`https://<backend>/v1/partners/cleaner/notifications`. Both sides require deployment
configuration checks; local fixtures do not prove production delivery. Subscriptions
never received by this backend are outside its observed totals.

The normal annual SKU `com.hecathehe.PhoneCleaner.yearly.standard` is now accepted
alongside weekly, special annual and lifetime. No iOS binary or App Review change
is required by this backend feature.

Validation: `node --test Backend/tests/subscription-lifecycle.test.mjs
Backend/tests/shared-transaction-inbox.test.mjs Backend/tests/product-operations.test.mjs
Backend/tests/admin-insights.test.mjs` passes 29 checks. This covers late/duplicate
events, re-enable, refund separation, trial conversion, unknown states, historical
backfill, cross-instance write serialization, Sandbox isolation, API identity and
signature failures, scheduled boundary/restart/retry logic, and standard annual
inbox ingestion. Production Apple calls are not exercised by these mocked tests.

The subscription cards and daily columns follow the user journey: recorded app
opens (daily active identities) → first subscription/trial → first payment → renewal
disabled. Conversion rates remain beside their corresponding stages with explicit
denominators. Daily stage counts are not a single-cohort funnel. `openedUsers` comes
from recorded session activity, not registrations; outside the existing 30-day
activity API window it is null (shown as “—”), not zero. Subscription history still
extends through all observed dates.


### Feedback identity and metric definitions (2026-10-20)

Cleaner session responses now include authenticated `user_id` and canonical
`device_id`. They are safe support lookup identifiers, distinct from the session
credential and App Store account token. The iOS feedback draft includes those IDs,
marketing device name, raw hardware identifier, OS, app/build, language and timezone.
It never includes credentials or attribution identifiers. Offline feedback retains
the existing installation ID; the backend user ID may be unavailable until a session
succeeds. Admin users can search either ID in both layouts. A reinstall may create a
new installation identity; these IDs do not identify a unique natural person.

The former registration-to-subscription column is replaced by people who have ever
successfully cleaned, grouped by registration day. The cleaner session accepts
`cleanupTrackingV1`, `hasCompletedCleanup` and optional `firstCleanupAt` (milliseconds).
Completion is monotonic and client-reported after successful cleanup, not after a
button tap. The app persists the first completion before sending, retries on later
launches and migrates the existing successful-cleanup count without fabricating a
date. Old untracked accounts remain unknown, not false. No media or contact content
is transmitted. These metrics require the updated app; old versions alone cannot
supply missing history.

Subscription metric labels include clickable question marks detailing cohort,
deduplication, denominator, event date, and known gaps. First payment is labelled
“首次实际扣款”: verified positive subscription charges only; zero-price free trials
are not paid conversion. Renewals do not count again as first payment. Both new
and returning users can make their first payment on a given date.

Validation for this change: 27 targeted backend tests passed across shared-product-
referrals, product-operations, admin-insights and subscription-lifecycle. Standalone
Swift feedback checks passed (15 Pro mapping, identifier inclusion, reserved URL
characters, offline fallback). The iOS simulator build succeeded. Both local admin
layouts were verified with synthetic IDs; question-mark dialogs and cleanup drilldown
were checked. This is local validation, not a production rollout or a real-device
email test. Deploy the backend before distributing the updated app.

### Advertising analytics and AppLovin (2026-10-20)

Both admin layouts include **广告投放** with acquisition-date filters, channel /
campaign / ad group / creative drilldown, imported spend, CTR, CPI, first observed
actual payer CPA, recorded journey stages, verified trials, and D7/D14/D30 cohort
net charges / observed ROAS. Missing costs or identities are not zero/organic.
Different currencies never combine. Revenue excludes zero-price trials, includes
linked renewals, and backfills known refunds to the original acquisition cohort.
It is not Apple net proceeds, profit, or a complete platform/SKAN ROAS estimate.
Observation windows are UTC calendar days starting on acquisition day.

Journey stages count first recorded occurrences, not a strict sequential funnel.
Clients send persisted first-event timestamps through their authenticated Cleaner
session. Old versions lack these events; users who update later have partial
history. Cleanup is a separate optional path. Actual trial conversion uses Apple's
`FREE_TRIAL` metadata, verified expiration, and a later positive charge on the same
subscription chain. Other zero-value transactions are not inferred as trials.

Admin-authenticated `POST /v1/admin/products/:product/marketing-import` accepts
`{kind:"costs"|"attribution",csv}` for a pure preview, then the same content plus
`confirm:true,fingerprint` to save. Templates are downloadable in the UI. Import
limits: 700 KB / 2000 rows, UTC costs, explicit currency, stable hierarchy IDs.
Exact keys update rather than accumulate. Mixed parent totals and child details,
duplicates within a file, future dates, invalid money, and unknown user IDs are
rejected. Attribution must map a first acquisition to an existing backend user ID;
retargeting and SKAN aggregates cannot be imported as first-acquisition identities.
The local preview allows validation but prohibits saves.

For Smart Cleaner, configure server-only `CLEANER_APPLOVIN_REPORT_KEY`, verified
`CLEANER_APPLOVIN_CURRENCY`, and `CLEANER_APPLOVIN_SYNC_ENABLED=true`. No key is
returned to the browser. The AppLovin advertiser Reporting API is filtered to
`com.hecathehe.PhoneCleaner` and acquisition (`ua`) campaigns. It maps stable
`campaign_id_external` to campaign and `creative_set_id` to ad group; individual
creative costs are not inferred. `conversions` supplies platform installs.
The connector requests `day_column=day`, paginates, and validates all rows before
persisting any. Every UTC day at 00:00 (Beijing 08:00), it refreshes the previous
seven complete days; startup catches up if needed, failures retry after an hour,
and completed days are persisted. Concurrent manual / scheduled calls coalesce.
The authenticated **立即核对 AppLovin 成本** button calls
`POST /v1/admin/products/cleaner/applovin-sync`. The job only runs while the server
is running; an always-on instance is required for punctual execution.

Successful full responses replace only connector-owned records inside the rolling
window, including rows removed by the source. Failed, oversized, malformed,
cross-product, or partial responses preserve old costs. Overlap with manual
AppLovin cost imports blocks synchronization rather than silently double counting.
Report currency is explicitly configured because the requested report has no
currency column. Confirm it against the account before enabling synchronization.
No external request runs without configuration. Existing user-level attribution
still requires a Singular export mapped to backend IDs; the AppLovin cost API
alone does not identify which user paid. Its serve-day cost attribution can differ
from an install-day cohort, so these observed ratios are not AppLovin's own ROAS.

Sources checked:
- https://support.applovin.com/en/growth/promoting-your-apps/api/reporting-api
- https://support.singular.net/hc/en-us/articles/360029844851-AppLovin-Attribution-Integration

Validation: 59 targeted tests passed, including pagination, credential redaction,
idempotent sync, UTC scheduling, source conflicts, failure rollback, CSV validation,
trial maturity, refunds and acquisition windows. The updated iOS simulator build
succeeded. Both admin layouts, source drilldown, metric explanations, product
switching and import preview/errors were exercised against synthetic local data.
Live AppLovin authentication, production deployment and a new app release remain
separate rollout steps; these tests do not imply an external account is connected.

Live-account follow-up: the existing Reporting Key returned HTTP 200 with a
zero-byte CSV for Cleaner on 2026-10-13 through 2026-10-19. The account UI showed
only an inactive draft without an app package. This response now verifies an empty
new account but cannot erase existing costs; a regression test covers both cases.
The user confirmed USD and authorized storing the reporting credential on the
existing Render service. All 103 backend tests passed before release preparation.
The credential is excluded from Git and all API/status output.
