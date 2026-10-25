import test from 'node:test';
import assert from 'node:assert/strict';
import {CSV_HEADERS,prepareMarketingImport,applyMarketingImport} from '../marketing-import.mjs';
const sdid='12345678-1234-5678-9234-123456789012';
const at='2026-10-20T00:00:00Z',now=Date.parse('2026-10-25T00:00:00Z');
const account={id:'anon_test',singularSdid:sdid,createdAt:at};
const state=()=>({sharedPartnerReferrals:{cleaner:{accounts:{anon_test:{...account}}}}});
const csv=(overrides={})=>{
 const row={singularSdid:sdid,acquiredAt:at,channel:'AppLovin',campaignId:'123',campaignName:'Test',source:'Singular install export',...overrides};
 return CSV_HEADERS.singular.join(',')+'\n'+CSV_HEADERS.singular.map(k=>row[k]||'').join(',');
};
test('Singular SDID matches one product user; repeat import updates rather than duplicates',()=>{
 const s=state(),p=prepareMarketingImport(s,'cleaner','singular',csv(),now);
 assert.equal(p.records[0].accountId,'anon_test');assert.equal(p.records[0].channel,'applovin');
 applyMarketingImport(s,'cleaner',p,now);
 const again=prepareMarketingImport(s,'cleaner','singular',csv(),now);
 assert.equal(again.added,0);assert.equal(again.replaced,1);
 applyMarketingImport(s,'cleaner',again,now);
 assert.equal(Object.keys(s.marketing.cleaner.attributions).length,1);
});
test('unknown, ambiguous, other-product and late acquisition records cannot attach',()=>{
 const s=state();
 assert.throws(()=>prepareMarketingImport(s,'dailyme','singular',csv(),now),/尚未关联/);
 s.sharedPartnerReferrals.cleaner.accounts.duplicate={...account,id:'duplicate'};
 assert.throws(()=>prepareMarketingImport(s,'cleaner','singular',csv(),now),/多个后台用户/);
 delete s.sharedPartnerReferrals.cleaner.accounts.duplicate;
 assert.throws(()=>prepareMarketingImport(s,'cleaner','singular',csv({acquiredAt:'2026-10-21T00:00:00Z'}),now),/首次会话/);
 assert.throws(()=>prepareMarketingImport(s,'cleaner','singular',csv({singularSdid:'bad'}),now),/格式无效/);
});
