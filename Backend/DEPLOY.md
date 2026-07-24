# Deploy SquadLive Backend

## Required Server Info

- Linux server with SSH access
- Domain name, for example `api.squadlive.app`
- HTTPS certificate through Nginx + Let's Encrypt
- `DEEPSEEK_API_KEY`
- Strong `ADMIN_TOKEN`

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

## iOS Config

Set `SQUADLIVE_API_BASE_URL` in the iOS target Info.plist build setting:

```text
https://api.squadlive.app
```
