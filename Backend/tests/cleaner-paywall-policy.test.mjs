import test from 'node:test';import assert from 'node:assert/strict';
import {defaultPaywallPolicy,validatePaywallPolicy,validatePublication,editPolicy,publishPolicy,publicPolicy,restorePolicyDraft} from '../cleaner-paywall-policy.mjs';
const now=Date.now();
const catalog=p=>[{productId:p.tiers.find(t=>t.id===p.selectedTier).productId,territory:'USA',state:'APPROVED',checkedAt:now,period:'ONE_WEEK',introDays:7,regularPrice:9.99,currency:'USD',introPriceCents:99,offerMode:'PAY_UP_FRONT'}];
test('all five verified Apple mappings are prefilled but disabled until publication checks pass',()=>{const p=defaultPaywallPolicy();assert.equal(p.tiers.length,5);assert.equal(p.enabled,false);assert.equal(p.tiers.filter(t=>t.productId).length,5);assert.deepEqual(p.tiers.map(t=>t.appleSubscriptionId),['6761750091','6825629063','6825702250','6825789166','6825844584']);assert.equal(p.surprise.enabled,false);assert.deepEqual(validatePaywallPolicy(p),p);});
test('draft edits do not affect clients; publication is revision guarded',()=>{const store={};const p=defaultPaywallPolicy();p.template='compact';const s=editPolicy(store,p,0,now);assert.equal(publicPolicy(store).policy.template,'storage');assert.throws(()=>publishPolicy(store,0,[],now),/变化/);publishPolicy(store,s.revision,[],now);assert.equal(publicPolicy(store).policy.template,'compact');});
test('paid tier can only publish after matching fresh Apple price and eligibility configuration',()=>{const p=defaultPaywallPolicy();p.enabled=true;p.selectedTier='intro099';p.tiers[1].productId='com.hecathehe.PhoneCleaner.weekly.intro099';assert.throws(()=>validatePublication(p,[],now),/核对/);const c=catalog(p);assert.equal(validatePublication(p,c,now).selectedTier,'intro099');c[0].introPriceCents=199;assert.throws(()=>validatePublication(p,c,now),/不一致/);c[0].introPriceCents=99;c[0].checkedAt=now-3600001;assert.throws(()=>validatePublication(p,c,now),/核对/);});
test('rejects foreign products, duplicate mappings and unbounded popup frequency',()=>{const p=defaultPaywallPolicy();p.tiers[1].productId=p.tiers[0].productId;assert.throws(()=>validatePaywallPolicy(p),/对应商品 ID|不同商品/);p.tiers[1].productId='other.app';assert.throws(()=>validatePaywallPolicy(p),/Smart Cleaner/);p.tiers[1].productId='';p.surprise.dismissCooldownHours=-1;assert.throws(()=>validatePaywallPolicy(p),/冷却/);});
test('server catalog approval cannot be supplied through policy input',()=>{const p=defaultPaywallPolicy();p.enabled=true;p.catalog=[{state:'APPROVED'}];assert.throws(()=>validatePublication(p,[],now),/核对/);assert.equal(validatePaywallPolicy(p).catalog,undefined);});

test('every requested tier switches independently across every template after Apple verification',()=>{
  const store={};let revision=0;
  for(const [index,amount] of [0,99,199,399,699].entries())for(const template of ['storage','compact','comparison']){
    const p=defaultPaywallPolicy();p.enabled=true;p.selectedTier=p.tiers[index].id;p.template=template;
    if(index)p.tiers[index].productId=`com.hecathehe.PhoneCleaner.weekly.${p.selectedTier}`;
    const c=catalog(p);c[0].introPriceCents=amount;c[0].offerMode=index?'PAY_AS_YOU_GO':'FREE_TRIAL';
    revision=editPolicy(store,p,revision,now).revision;
    revision=publishPolicy(store,revision,c,now).revision;
    assert.equal(publicPolicy(store).policy.selectedTier,p.selectedTier);
    assert.equal(publicPolicy(store).policy.template,template);
  }
});
test('surprise offer must be verified in the selected storefront',()=>{
  const p=defaultPaywallPolicy();p.enabled=true;p.surprise.enabled=true;
  const c=catalog(p);c[0].introPriceCents=0;c[0].offerMode='FREE_TRIAL';
  c.push({productId:p.surprise.productId,territory:'CAN',state:'APPROVED',period:'ONE_YEAR',regularPrice:19.99,checkedAt:now});
  assert.throws(()=>validatePublication(p,c,now),/销售地区/);
  c[1].territory='USA';assert.equal(validatePublication(p,c,now).surprise.enabled,true);
});

test('all US introductory tiers require the confirmed 9.99 weekly renewal price',()=>{
  const p=defaultPaywallPolicy();p.enabled=true;
  const c=catalog(p);c[0].introPriceCents=0;c[0].offerMode='FREE_TRIAL';
  c[0].regularPrice=9.90;assert.throws(()=>validatePublication(p,c,now),/9.99/);
  c[0].regularPrice=9.99;assert.equal(validatePublication(p,c,now).selectedTier,'free7');
});

test('history restore is revision guarded, isolated from live state, and revalidated on publish',()=>{
  const store={};const p=defaultPaywallPolicy();p.enabled=true;p.selectedTier='intro099';p.tiers[1].productId='com.hecathehe.PhoneCleaner.weekly.intro099';
  editPolicy(store,p,0,now);publishPolicy(store,1,catalog(p),now);
  const replacement=defaultPaywallPolicy();replacement.template='comparison';
  editPolicy(store,replacement,2,now);publishPolicy(store,3,[],now);
  const before=publicPolicy(store);
  assert.throws(()=>restorePolicyDraft(store,2,3,now),/刷新/);
  assert.throws(()=>restorePolicyDraft(store,999,4,now),/不存在/);
  const restored=restorePolicyDraft(store,2,4,now);assert.equal(restored.revision,5);
  assert.equal(restored.draft.selectedTier,'intro099');assert.deepEqual(publicPolicy(store),before);
  assert.throws(()=>publishPolicy(store,5,[],now),/核对/);
  assert.deepEqual(publicPolicy(store),before);
  restored.draft.template='compact';assert.equal(store.cleanerPaywallPolicy.draft.template,'storage');
  publishPolicy(store,5,catalog(p),now);assert.equal(publicPolicy(store).policy.selectedTier,'intro099');
});
