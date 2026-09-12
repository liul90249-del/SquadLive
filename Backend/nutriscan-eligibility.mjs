const deny=(message,status=409)=>Object.assign(new Error(message),{status});
/** All identity fields must come from authenticated server state, never an HTTP body. */
export function createNutriScanEligibility({loadAppEvidence,checkHistory,now=()=>Date.now()}){
 return async function verify(identity){
  if(!identity?.customerId||identity.product!=='nutriscan'||identity.environment!=='Production'||identity.identityVerified!==true)
   throw deny('Verified NutriScan installation identity required',401);
  if(!Number.isSafeInteger(identity.registeredAt)||identity.registeredAt<=0||identity.registeredAt>now()/1000)
   throw deny('Verified first-use timestamp required');
  if(now()/1000-identity.registeredAt>7*86400)throw deny('New-account binding window expired');
  const evidence=await loadAppEvidence(identity);
  if(!evidence||evidence.product!=='nutriscan'||evidence.environment!=='Production'||evidence.app_transaction_id!==identity.appTransactionId)
   throw deny('Verified Apple app history required');
  // An acquisition date is not a substitute for the installation's first use.
  // A contradictory timestamp must be reviewed, never silently moved forward.
  if(!Number.isSafeInteger(evidence.original_purchase_date)||evidence.original_purchase_date<=0||evidence.original_purchase_date>identity.registeredAt*1000+300000)
   throw deny('App history and first-use timestamp conflict');
  const started=now(),result=await checkHistory(identity);
  if(!result||result.complete!==true||!Number.isSafeInteger(result.checked_at)||result.checked_at<started||result.checked_at>now()+300000)
   throw deny('Fresh complete Apple purchase history required',503);
  if(result.has_paid===true)throw deny('A referral must be bound before your first purchase');
  if(result.has_paid!==false||result.amount_unknown!==false||result.eligible!==true)
   throw deny('Apple purchase history requires review',503);
  return {verified:true,checked_at:result.checked_at};
 };
}
