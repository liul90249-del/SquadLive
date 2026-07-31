# Deploy SquadLive Backend

## Required Server Info

- Linux server with SSH access
- Domain name, for example `api.squadlive.app`
- HTTPS certificate through Nginx + Let's Encrypt
- `DEEPSEEK_API_KEY`
- Strong `ADMIN_TOKEN`
- Persistent storage through a mounted disk or managed PostgreSQL

## Render Deployment

This repo includes `render.yaml` for the current Render deployment:

```text
https://squadlive.onrender.com
```

The blueprint declares:

- `DATA_DIR=/var/data`
- Secret env vars for `DEEPSEEK_API_KEY` and `ADMIN_TOKEN`
- A 1 GB persistent disk mounted at `/var/data`

Confirm these are present in the Render dashboard after deployment. If the service is downgraded to a Free instance without a persistent disk, local JSON data can be lost.

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

Coin and VIP endpoints are currently mock purchase endpoints. Before real launch:

- Create coin consumable product IDs in App Store Connect.
- Create VIP subscription product IDs in App Store Connect.
- Replace mock purchase calls with StoreKit purchases in the iOS app.
- Add server-side App Store transaction or receipt validation before granting coins or VIP.
