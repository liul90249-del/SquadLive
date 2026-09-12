import {createPublicKey, verify} from 'node:crypto';
// Keys are fetched only from Apple. Header URLs and caller-provided keys are ignored.
export function createAppleIdentityVerifier({audience, fetchKeys = async () => {
 const r = await fetch('https://appleid.apple.com/auth/keys', {signal: AbortSignal.timeout(5000)});
 if (!r.ok) throw new Error('Apple identity service unavailable');
 return (await r.json()).keys;
}, now = () => Math.floor(Date.now()/1000)}) {
 let cached = [], expires = 0, lastRefresh = -Infinity;
 return async (token, expectedNonce) => {
  if (typeof token !== 'string' || token.length > 16000) throw new Error('Invalid Apple identity token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) throw new Error('Invalid Apple identity token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported Apple signing algorithm');
  const time = now();
  if (time >= expires || (!cached.some(k => k.kid === header.kid) && time-lastRefresh >= 60)) {
   cached = await fetchKeys(); expires = time + 3600; lastRefresh = time;
  }
  const key = cached.find(k => k.kid === header.kid && k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig');
  if (!key || !verify('RSA-SHA256', Buffer.from(parts[0]+'.'+parts[1]), createPublicKey({key,format:'jwk'}), Buffer.from(parts[2],'base64url')))
   throw new Error('Invalid Apple identity signature');
  if (payload.iss !== 'https://appleid.apple.com' || payload.aud !== audience || typeof payload.sub !== 'string' || !payload.sub
   || !Number.isInteger(payload.exp) || payload.exp <= time || !Number.isInteger(payload.iat) || payload.iat > time+300
   || (expectedNonce !== undefined && payload.nonce !== expectedNonce)) throw new Error('Apple identity verification failed');
  return payload;
 };
}
