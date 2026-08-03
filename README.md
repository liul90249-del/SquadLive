# SquadLive

SquadLive is an AI live-streaming companion app with simulated audience activity, AI replies, virtual gifts, saved video rewards, and a lightweight backend/admin dashboard.

## Project Structure

- `AI Live Streaming/` - iOS app source and assets
- `Backend/` - Node.js backend and admin dashboard
- `render.yaml` - Render deployment blueprint

## Backend

Local backend:

```bash
cd Backend
npm run dev
```

Admin dashboard:

```text
http://127.0.0.1:8787/admin
```

Production URLs:

```text
API: https://squadlive.onrender.com
Admin: https://squadlive.onrender.com/admin
Privacy Policy: https://squadlive.onrender.com/privacy
Terms of Use: https://squadlive.onrender.com/terms
```

Required production environment variables:

```text
DEEPSEEK_API_KEY
ADMIN_TOKEN
DATA_DIR
```

The Render blueprint uses `DATA_DIR=/var/data` with a 1 GB persistent disk. Keep that disk enabled for JSON storage, or migrate the backend store to PostgreSQL before relying on long-term production data.

The backend now keeps one shared in-memory store per instance, persists changes through an atomic serialized write queue, and limits AI work with `AI_MAX_CONCURRENCY` and `AI_QUEUE_LIMIT`. The `/admin` dashboard reports daily usage, AI latency/failures, queue pressure, memory, disk usage, and upgrade warnings. Set `INSTANCE_MEMORY_MB` to the actual instance memory limit so the memory percentage is accurate.

## iOS Release Config

The Release build setting `SQUADLIVE_API_BASE_URL` is configured as:

```text
https://squadlive.onrender.com
```

Debug still points to the local backend:

```text
http://127.0.0.1:8787
```
