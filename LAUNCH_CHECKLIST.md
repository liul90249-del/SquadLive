# SquadLive Launch Checklist

## Render

- `ADMIN_TOKEN` is set to a long random value in Render.
- `DEEPSEEK_API_KEY` is set in Render.
- `DATA_DIR` is `/var/data`.
- Persistent Disk is enabled and mounted at `/var/data`.
- Health check passes at `https://squadlive.onrender.com/health`.
- Health payment status reports `productionReady: true` and `appStoreVerificationConfigured: true`.
- Admin page loads at `https://squadlive.onrender.com/admin`.
- Privacy Policy loads at `https://squadlive.onrender.com/privacy`.
- Terms of Use loads at `https://squadlive.onrender.com/terms`.

## iOS

- Release `SQUADLIVE_API_BASE_URL` is `https://squadlive.onrender.com`.
- Debug `SQUADLIVE_API_BASE_URL` remains `http://127.0.0.1:8787`.
- `DEEPSEEK_API_KEY` is not shipped in the app for production.
- Sign in with Apple capability is enabled and account linking succeeds from Settings.

## App Store Connect

- Privacy Policy URL: `https://squadlive.onrender.com/privacy`
- Terms of Use URL: `https://squadlive.onrender.com/terms`
- Create coin consumable products.
- Create VIP subscription products.
- Add subscription review information and screenshots.
- Configure server-side App Store transaction or receipt validation before granting real coins/VIP.
- Configure App Store Server Notifications V2 for both Production and Sandbox:
  `https://squadlive.onrender.com/v1/storekit/notifications`
- Set `APPLE_APP_ID` to the numeric App Store Connect app ID in Render.
- Run `scripts/storekit-regression.sh` and complete its manual matrix on a Sandbox/TestFlight device.

## Current Purchase Status

The backend endpoints `/v1/coins/purchase` and `/v1/vip/subscribe` are mock purchase endpoints. They are useful for testing admin records and app flows, but they should not be used as real payment validation.
