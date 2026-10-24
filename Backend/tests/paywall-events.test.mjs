import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePaywallEvents,mergePaywallEvents} from '../paywall-events.mjs';
import {createSharedProductReferrals} from '../shared-product-referrals.mjs';
const now=Date.UTC(2026,9,24);
const event={id:'10000000-0000-4000-8000-000000000001',presentationId:'20000000-0000-4000-8000-000000000001',
 name:'paywall_open',at:now,revision:1,tier:'intro099',template:'compact',surface:'main',entryPoint:'return_visit',productId:'com.hecathehe.PhoneCleaner.weekly.intro099'};
test('retries do not duplicate or rewrite exposure; client revenue is discarded',()=>{
 const account={};const accepted=validatePaywallEvents([{...event,price:999999,currency:'USD'}],now);
 mergePaywallEvents(account,accepted,now);
 mergePaywallEvents(account,validatePaywallEvents([{...event,tier:'intro699'}],now),now+1);
 assert.equal(account.paywallEvents.length,1);assert.equal(account.paywallEvents[0].tier,'intro099');
 assert.equal(account.paywallEvents[0].price,undefined);
});
test('invalid payloads fail before storage',()=>{
 for(const patch of [{at:now+300001},{revision:-1},{tier:'arbitrary'},{template:'unknown'},{name:'purchase_success'},{entryPoint:'<script>'},{id:'bad'}])
  assert.throws(()=>validatePaywallEvents([{...event,...patch}],now),/Invalid paywall/);
 assert.throws(()=>validatePaywallEvents(Array(101).fill(event),now),/Invalid paywall/);
 assert.deepEqual(validatePaywallEvents(undefined,now),[]);
});
test('bounded retention explicitly marks incomplete history',()=>{
 const account={};
 for(let i=0;i<501;i++)mergePaywallEvents(account,[{...event,id:`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,at:now+i}],now+i);
 assert.equal(account.paywallEvents.length,500);assert.equal(account.paywallHistoryTruncated,true);
 assert.equal(account.paywallEvents[0].at,now+1);
});
test('session ties events to authenticated installation without changing legacy clients',async()=>{
 let root={};
 const service=createSharedProductReferrals({getStore:async()=>root,saveStore:async value=>{root=value},clients:{},products:{cleaner:{}},now:()=>now});
 const first=await service.session('cleaner',{deviceId:'30000000-0000-4000-8000-000000000001'});
 await service.session('cleaner',{credential:first.token,paywallEvents:[event]});
 const account=root.sharedPartnerReferrals.cleaner.accounts[first.user_id];
 assert.equal(account.paywallEvents.length,1);
 await service.session('cleaner',{credential:first.token});
 assert.equal(account.paywallEvents.length,1);
 await assert.rejects(service.session('cleaner',{credential:'invalid',paywallEvents:[{...event,id:'40000000-0000-4000-8000-000000000001'}]}),/credential/);
 assert.equal(account.paywallEvents.length,1);
});
