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

Coin balances are server-authoritative. Verified purchases, audience spending, daily share rewards, and reviewed bonuses update the backend ledger first. Wallet operation IDs make retries idempotent so the same request cannot charge or reward twice.

Data is stored in `data/store.json` for local development. Replace this with a real database before production.
