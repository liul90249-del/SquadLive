#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SQUADLIVE_API_BASE_URL:-http://127.0.0.1:8787}"
HEALTH="${BASE_URL%/}/health"

payload="$(curl --fail --silent --show-error "$HEALTH")"
node -e '
const data = JSON.parse(process.argv[1]);
if (!data.ok) throw new Error("health.ok is false");
if (!data.payments) throw new Error("payments health status is missing");
console.log(JSON.stringify(data.payments, null, 2));
' "$payload"

cat <<'CHECKLIST'

StoreKit manual regression matrix:
1. Sandbox/TestFlight: buy each consumable; verify exactly one server ledger entry.
2. Kill the app immediately after Apple approval; relaunch; verify one balance increase and transaction finishes.
3. Disable network after approval; relaunch with network restored; verify unfinished transaction is claimed once.
4. Replay the same consumable callback; verify no second balance increase.
5. Start a paid lobby session twice; verify the first eligible start is free and the next start charges the server price.
6. Add live viewers with insufficient cached coins; verify the server returns insufficient funds and no local audience increase occurs.
7. Submit the same audience operation twice; verify the second response is duplicate=true with no extra charge.
8. Reuse an operation ID with different viewers/context; verify HTTP 409.
9. Buy weekly and annual subscriptions; verify only the active entitlement is reflected.
10. Cancel, renew, enter billing retry/grace period, refund, and revoke; verify App Store Server Notifications update the backend.
11. Restore purchases on a second TestFlight device signed into the same Apple account.
12. Sign in with Apple from Settings; verify accountLinked=true and the wallet remains unchanged.
CHECKLIST
