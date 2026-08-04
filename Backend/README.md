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

Data is stored in `data/store.json` for local development. Replace this with a real database before production.
