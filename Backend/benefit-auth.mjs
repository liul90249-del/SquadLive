import {randomBytes, createHash} from 'node:crypto';
// Short-lived in-memory sessions deliberately fail closed across backend restarts.
export function createBenefitAuth({verifyApple, resolveUser, onAuthenticated = async () => ({}), now = () => Date.now()}) {
 const challenges = new Map(), sessions = new Map();
 const hash = s => createHash('sha256').update(s).digest('hex');
 const prune = map => {for (const [key,value] of map) if(value.expires <= now()) map.delete(key)};
 return {
  challenge() {
   prune(challenges);
   if(challenges.size >= 1000) throw new Error('Please try again later');
   const nonce = randomBytes(32).toString('hex');
   challenges.set(nonce,{expires:now()+300000});
   return {nonce};
  },
  async login({nonce,identityToken}) {
   prune(challenges);
   if(typeof nonce !== 'string' || !challenges.delete(nonce)) throw new Error('Please sign in again');
   const identity = await verifyApple(identityToken,nonce);
   const user = await resolveUser(identity.sub);
   if(!user || user.appleSubject !== identity.sub || !user.id || !Number.isFinite(Date.parse(user.createdAt))) throw new Error('Link your Apple account in Settings first');
   prune(sessions);
   if(sessions.size >= 10000) throw new Error('Please try again later');
   const token = randomBytes(32).toString('base64url');
   sessions.set(hash(token),{subject:identity.sub,customerId:user.id,registeredAt:Math.floor(Date.parse(user.createdAt)/1000),expires:now()+900000});
   return {token,expires_in:900,...await onAuthenticated(user)};
  },
  async verify(req) {
   prune(sessions);
   const token = req.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
   const session = token && sessions.get(hash(token));
   if(!session) throw new Error('Please sign in again');
   const user = await resolveUser(session.subject);
   if(!user || user.id !== session.customerId || user.appleSubject !== session.subject) throw new Error('Account link changed');
   return {customerId:session.customerId,registeredAt:session.registeredAt};
  }
 };
}
