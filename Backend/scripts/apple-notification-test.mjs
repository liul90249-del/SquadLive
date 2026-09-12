// Usage: node scripts/apple-notification-test.mjs request|status Production|Sandbox key-file key-id issuer-id result-file
import {readFile,open,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AppStoreServerAPIClient,Environment,SignedDataVerifier} from '@apple/app-store-server-library';
const [action,environment,keyFile,keyId,issuerId,resultFile]=process.argv.slice(2);
const bundle='com.liuzhigang.NutriScan',appId=6786940107;
try {
 if(!['request','status'].includes(action)||!['Production','Sandbox'].includes(environment)||!keyFile||!keyId||!issuerId||!resultFile)throw Error('Usage: request|status Production|Sandbox key-file key-id issuer-id result-file');
 const client=new AppStoreServerAPIClient(await readFile(keyFile,'utf8'),keyId,issuerId,bundle,environment==='Production'?Environment.PRODUCTION:Environment.SANDBOX);
 if(action==='request'){
  // Reserve the output before requesting Apple: do not unknowingly send another
  // notification when an earlier attempt may already have been accepted.
  const file=await open(resultFile,'wx',0o600);
  try{
   await file.writeFile(JSON.stringify({environment,appId,status:'request_started',requested_at:Date.now()}));await file.sync();
   const result=await client.requestTestNotification();
   if(!result.testNotificationToken)throw Error('Apple returned no test token');
   await file.truncate(0);await file.write(JSON.stringify({environment,appId,status:'requested',token:result.testNotificationToken,requested_at:Date.now()}),0,'utf8');await file.sync();
   console.log(JSON.stringify({environment,status:'requested',result_file:resultFile}));
  }finally{await file.close()}
 }else{
  const saved=JSON.parse(await readFile(resultFile,'utf8'));
  if(saved.environment!==environment||saved.appId!==appId||!saved.token)throw Error('Result file does not contain the matching Apple request token');
  const result=await client.getTestNotificationStatus(saved.token);
  const roots=await Promise.all(['AppleIncRootCertificate.cer','AppleRootCA-G2.cer','AppleRootCA-G3.cer'].map(name=>readFile(fileURLToPath(new URL('../certs/'+name,import.meta.url)))));
  const verifier=new SignedDataVerifier(roots,true,environment==='Production'?Environment.PRODUCTION:Environment.SANDBOX,bundle,environment==='Production'?appId:undefined);
  if(!result.signedPayload)throw Error('Apple has not supplied the signed test notification yet');
  const notification=await verifier.verifyAndDecodeNotification(result.signedPayload);
  if(notification.notificationType!=='TEST'||!notification.notificationUUID)throw Error('Unexpected signed Apple notification');
  const delivered=result.sendAttempts?.some(attempt=>attempt.sendAttemptResult==='SUCCESS')===true;
  await writeFile(resultFile,JSON.stringify({...saved,checked_at:Date.now(),delivered,notification_id:notification.notificationUUID,send_attempts:result.sendAttempts}),{mode:0o600});
  console.log(JSON.stringify({environment,delivered,notification_id:notification.notificationUUID,send_attempts:result.sendAttempts}));
 }
}catch(error){console.error(JSON.stringify({ok:false,error:error.apiError?'Apple API request failed':error.message,http_status:error.httpStatusCode,apple_error:error.apiError}));process.exitCode=1}
