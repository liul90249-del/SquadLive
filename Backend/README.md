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
- `POST /v1/ai/deepseek`
- `POST /v1/audience/quote`
- `POST /v1/audience/commit`
- `POST /v1/rewards/share-submissions`
- `POST /v1/rewards/:submissionId/review`

Data is stored in `data/store.json` for local development. Replace this with a real database before production.
