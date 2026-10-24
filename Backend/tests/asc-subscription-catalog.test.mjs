import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createCleanerCatalogReader, interpretCleanerCatalog} from '../asc-subscription-catalog.mjs';

const now = Date.parse('2026-10-12T10:00:00Z');
const subscription = {attributes:{productId:'com.hecathehe.PhoneCleaner.weekly',subscriptionPeriod:'ONE_WEEK'}};
const price = (id, amount, startDate = null) => ({type:'subscriptionPrices', id,
  attributes:{startDate, preserved:false},relationships:{territory:{data:{id:'USA'}},subscriptionPricePoint:{data:{id:`point-${id}`}}}});
const prices = {data:[price('current','9.99'),price('future','12.90','2026-11-01')],included:[
  {type:'territories',id:'USA',attributes:{currency:'USD'}},
  {type:'subscriptionPricePoints',id:'point-current',attributes:{customerPrice:'9.99'}},
  {type:'subscriptionPricePoints',id:'point-future',attributes:{customerPrice:'12.90'}}
]};
const offer = {type:'subscriptionIntroductoryOffers',attributes:{offerMode:'FREE_TRIAL',duration:'ONE_WEEK',numberOfPeriods:1,startDate:'2026-10-01'},
  relationships:{territory:{data:{id:'USA'}}}};

test('catalog target is confirmed only by active US price and trial, not future pricing', () => {
  const result = interpretCleanerCatalog(subscription, prices, {data:[offer]}, now);
  assert.equal(result.status,'matched');
  assert.equal(result.actual.price,'9.99');
  assert.equal(result.actual.sevenDayTrial,true);
  assert.equal(interpretCleanerCatalog(subscription, prices, {data:[]}, now).status,'mismatch');
  assert.equal(interpretCleanerCatalog(subscription, {data:[],included:[]}, {data:[offer]}, now).status,'incomplete');
  assert.throws(() => interpretCleanerCatalog({attributes:{productId:'another.app',subscriptionPeriod:'ONE_WEEK'}},prices,{data:[offer]},now),/another product/);
});

test('missing ASC credentials remain visibly unverified and cause no network request', async () => {
  const read = createCleanerCatalogReader({subscriptionId:'123',fetcher:async()=>{throw new Error('must not fetch');}});
  assert.deepEqual(await read(),{status:'unconfigured',checkedAt:null,
    target:{territory:'USA',currency:'USD',price:'9.99',period:'ONE_WEEK',trialDays:7},actual:null,matchesTarget:null});
});

test('read-only ASC request interprets current price and caches the result', async () => {
  const {privateKey} = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const calls=[];
  const reader = createCleanerCatalogReader({keyId:'TESTKEY',issuerId:'issuer',privateKey:privateKey.export({format:'pem',type:'pkcs8'}),
    subscriptionId:'123',now:()=>now,fetcher:async(url,options)=>{
      calls.push(String(url));
      if (url.pathname.endsWith('/introductoryOffers')) {
        assert.equal(url.searchParams.get('include'), 'territory', 'Apple omits territory relationships unless explicitly included');
      }
      assert.match(options.headers.Authorization,/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      const body = url.pathname.endsWith('/prices') ? prices
        : url.pathname.endsWith('/introductoryOffers') ? {data:[offer]} : {data:subscription};
      return new Response(JSON.stringify(body),{status:200});
    }});
  assert.equal((await reader()).status,'matched');
  assert.equal((await reader()).status,'matched');
  assert.equal(calls.length,3);
  assert.ok(calls.every(url => url.startsWith('https://api.appstoreconnect.apple.com/v1/subscriptions/123')));
});
