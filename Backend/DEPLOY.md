# Deploy SquadLive Backend

## Required Server Info

- Linux server with SSH access
- Domain name, for example `api.squadlive.app`
- HTTPS certificate through Nginx + Let's Encrypt
- `DEEPSEEK_API_KEY`
- Strong `ADMIN_TOKEN`
- Numeric App Store app ID in `APPLE_APP_ID`
- Persistent storage through a mounted disk or managed PostgreSQL

## Render Deployment

This repo includes `render.yaml` for the current Render deployment:

```text
https://squadlive.onrender.com
```

The blueprint declares:

- `DATA_DIR=/var/data`
- Secret env vars for `DEEPSEEK_API_KEY` and `ADMIN_TOKEN`
- `APPLE_BUNDLE_ID=com.liuzhigang.AI-Live-Streaming`
- Secret `APPLE_APP_ID` containing the numeric App Store app ID
- A 1 GB persistent disk mounted at `/var/data`
- `AI_MAX_CONCURRENCY=40`, `AI_QUEUE_LIMIT=300`, and `INSTANCE_MEMORY_MB=512`

Confirm these are present in the Render dashboard after deployment. If the service is downgraded to a Free instance without a persistent disk, local JSON data can be lost.

The admin dashboard at `/admin` includes daily request and AI usage, average/max AI latency, timeout and provider failure counts, queue pressure, process memory, disk usage, and upgrade warnings. The current JSON store is protected against same-process concurrent overwrites, but PostgreSQL remains the recommended next step before running multiple instances.

## Basic Deployment

```bash
ssh root@YOUR_SERVER
apt update
apt install -y nodejs npm nginx certbot python3-certbot-nginx

mkdir -p /opt/squadlive
cd /opt/squadlive
# upload Backend files here
npm install --omit=dev

cat > .env <<EOF
PORT=8787
DEEPSEEK_API_KEY=your_deepseek_key
ADMIN_TOKEN=use-a-long-random-token
APPLE_BUNDLE_ID=com.liuzhigang.AI-Live-Streaming
APPLE_APP_ID=your_numeric_app_store_id
EOF

npm run start
```

Use `pm2` or a systemd service for long-running production.

## Nginx Example

```nginx
server {
  server_name api.squadlive.app;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then run:

```bash
certbot --nginx -d api.squadlive.app
```

## Admin

Open:

```text
https://api.squadlive.app/admin
```

Enter `ADMIN_TOKEN` in the top-right field.

For the current Render service:

```text
https://squadlive.onrender.com/admin
```

## iOS Config

Set `SQUADLIVE_API_BASE_URL` in the iOS target Info.plist build setting:

```text
https://api.squadlive.app
```

For the current Render service, Release is configured as:

```text
https://squadlive.onrender.com
```

## Legal Links

Use these links for App Store Connect and in-app purchase metadata while the Render service is the production backend:

```text
Privacy Policy: https://squadlive.onrender.com/privacy
Terms of Use: https://squadlive.onrender.com/terms
```

## App Store URLs

Use these public pages for App Store Connect after deploying the current backend version:

```text
Marketing URL: https://squadlive.onrender.com/
Support URL: https://squadlive.onrender.com/support
```

## App Store Purchases

Verified StoreKit purchases use:

- `POST /v1/storekit/coins/claim` for consumable coin packs.
- `POST /v1/storekit/subscriptions/claim` for PRO subscriptions and renewals received by the app.
- `POST /v1/storekit/notifications` for App Store Server Notifications V2.

- The iOS app attaches a stable `appAccountToken` to each coin purchase.
- The backend verifies Apple's signed transaction with Apple's official server library and bundled Apple root certificates.
- Product IDs are allowlisted and the signed account token must match the requesting device account.
- Each Apple transaction ID can be credited only once; retries return the existing result without adding coins again.
- Production verification requires `APPLE_APP_ID`. Sandbox/TestFlight verification does not require it.
- Mock coin and VIP routes are disabled when `NODE_ENV=production`; local development requires `ENABLE_MOCK_PURCHASES=true`.

Before relying on the backend as the sole subscription authority, configure App Store Server Notifications V2 so renewals, billing retry, grace-period changes, refunds, and revocations are received even when the app is not running.

In App Store Connect, configure the production and sandbox notification URLs to:

```text
https://api.squadlive.app/v1/storekit/notifications
```

For the current Render service, use:

```text
https://squadlive.onrender.com/v1/storekit/notifications
```

The endpoint verifies the signed notification and its nested transaction and renewal JWS values, deduplicates by `notificationUUID`, and updates subscriptions by `originalTransactionId`. Unlinked legacy transactions are retained for later reconciliation instead of being assigned to an arbitrary device.

The legacy `/v1/coins/purchase` and `/v1/vip/subscribe` routes remain mock development routes and must not be called by production clients.

## Authoritative Coin Wallet

The backend is the source of truth for coin balances after this deployment:

- `POST /v1/wallet/balance` returns the current server balance for the device account.
- Verified StoreKit claims return the complete server balance instead of asking the client to add coins locally.
- Lobby and in-live audience purchases are charged through `POST /v1/audience/commit`.
- Share rewards are granted through `POST /v1/rewards/share-submissions`.
- Wallet operation IDs make retries idempotent and prevent duplicate charges or duplicate daily rewards.
- The first valid share submission of each calendar day grants 100 coins. Daily reset uses `REWARD_TIME_ZONE` and defaults to `Asia/Shanghai`.
- If the backend is unavailable, paid actions are blocked and the cached balance is display-only.

Balances that existed only in an older app's local preferences are intentionally not trusted or uploaded. Verified purchases and server-recorded rewards remain in the backend ledger; manually altered local balances are replaced during the next successful wallet sync.
