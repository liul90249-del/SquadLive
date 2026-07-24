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

Required production environment variables:

```text
DEEPSEEK_API_KEY
ADMIN_TOKEN
DATA_DIR
```
