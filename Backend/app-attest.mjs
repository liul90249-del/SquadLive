import {verifyAttestation,verifyAssertion} from 'node-app-attest';
import cbor from 'cbor';
import {createHash,randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {mkdir,readFile,open,rename} from 'node:fs/promises';
import {join} from 'node:path';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=401)=>Object.assign(new Error(message),{status});
const bundleIdentifier='com.liuzhigang.NutriScan',teamIdentifier='D9QJA58T8W';
async function save(file,value){const tmp=file+'.'+randomUUID()+'.tmp';const h=await open(tmp,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync()}finally{await h.close()}await rename(tmp,file)}
function decode(value){if(typeof value!=='string'||value.length>131072||!value.length||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw fail('Invalid device proof',400);return Buffer.from(value,'base64')}
export function validateAttestation(args){
 // Supplement the dependency's signature-chain checks with certificate dates.
 const decoded=cbor.decodeAllSync(args.attestation);
 if(decoded.length!==1||!Array.isArray(decoded[0]?.attStmt?.x5c))throw fail('Invalid device certificate');
 for(const der of decoded[0].attStmt.x5c){const cert=new X509Certificate(der);if(Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<Date.now())throw fail('Device certificate expired or not yet valid')}
 return verifyAttestation({...args,bundleIdentifier,teamIdentifier,allowDevelopmentEnvironment:false});
}
export function validateAssertion(args){
 const decoded=cbor.decodeAllSync(args.assertion);
 if(decoded.length!==1||!Buffer.isBuffer(decoded[0]?.authenticatorData)||decoded[0].authenticatorData.length!==37||!Buffer.isBuffer(decoded[0]?.signature))throw fail('Invalid assertion format');
 return verifyAssertion(args);
}
export function createDeviceAttest({directory,now=()=>Date.now(),attest=validateAttestation,assert=validateAssertion}){
 let queue=Promise.resolve();
 const serialized=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result};
 async function load(identity){
  if(!directory)throw fail('Persistent device storage required',503);
  if(identity?.product!=='nutriscan'||!['Production','Sandbox'].includes(identity.environment)||!/^nutri_[a-f0-9-]{36}$/.test(identity.customerId||'')||!/^\d{1,128}$/.test(identity.appTransactionId||''))throw fail('Authenticated installation required');
  const root=join(directory,'partner-devices');await mkdir(root,{recursive:true});
  const file=join(root,hash(identity.environment+':'+identity.customerId)+'.json');let state;
  try{state=JSON.parse(await readFile(file,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  return {file,root,state:state||{customer_id:identity.customerId,environment:identity.environment,app_transaction_id:identity.appTransactionId}};
 }
 return {
  status:identity=>serialized(async()=>{const {state}=await load(identity);return {key_id:state.key_id||null,device_attested:!!state.key_id,commission_eligible:false}}),
  challenge:(identity,kind)=>serialized(async()=>{
   if(!['attest','assert'].includes(kind))throw fail('Invalid challenge purpose',400);
   const {file,state}=await load(identity);
   if(kind==='assert'&&!state.key_id)throw fail('Attest this device first');
   if(state.challenge&&now()-state.challenge.created_at<3000)throw fail('Retry challenge later',429);
   const challenge=randomBytes(32).toString('hex');
   const payload=[challenge,identity.customerId,identity.appTransactionId,'device-check'].join('\n');
   state.challenge={value:challenge,payload,kind,created_at:now(),expires_at:now()+120000};await save(file,state);
   return {challenge,payload,expires_in:120,key_id:state.key_id||null};
  }),
  verify:(identity,{kind,key_id,challenge,proof})=>serialized(async()=>{
   const {file,root,state}=await load(identity),bytes=decode(proof);
   if(typeof key_id!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(key_id))throw fail('Invalid device key',400);
   if(kind==='attest'&&state.key_id===key_id&&state.attestation_hash===hash(bytes))return {device_attested:true,commission_eligible:false};
   const issued=state.challenge;
   if(!issued||issued.kind!==kind||issued.value!==challenge||issued.expires_at<=now())throw fail('Device challenge expired or already used');
   state.challenge=null;await save(file,state);
   if(kind==='attest'){
    if(state.key_id)throw fail('Existing device key cannot be replaced',409);
    let result;try{result=await attest({attestation:bytes,challenge:issued.value,keyId:key_id,bundleIdentifier,teamIdentifier,allowDevelopmentEnvironment:false})}catch{throw fail('Apple device attestation failed')}
    if(result?.keyId!==key_id||result.environment!=='production'||typeof result.publicKey!=='string')throw fail('Invalid attested device result');
    const ownerFile=join(root,'key-'+hash(key_id)+'.json');let owner;
    try{owner=JSON.parse(await readFile(ownerFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
    if(owner&&(owner.customer_id!==identity.customerId||owner.environment!==identity.environment))throw fail('Device key belongs to another installation',409);
    await save(ownerFile,{customer_id:identity.customerId,environment:identity.environment});
    Object.assign(state,{key_id,public_key:result.publicKey,sign_count:0,attestation_hash:hash(bytes),first_attested_at:now()});await save(file,state);
    return {device_attested:true,commission_eligible:false};
   }
   if(kind!=='assert'||state.key_id!==key_id)throw fail('Attested device key required');
   let result;try{result=await assert({assertion:bytes,payload:issued.payload,publicKey:state.public_key,bundleIdentifier,teamIdentifier,signCount:state.sign_count})}catch{throw fail('Device assertion verification failed')}
   if(!Number.isSafeInteger(result?.signCount)||result.signCount<=state.sign_count)throw fail('Device assertion was replayed');
   state.sign_count=result.signCount;state.last_asserted_at=now();await save(file,state);
   // This is a device proof only. It does not establish a historical first-use date.
   return {device_verified:true,commission_eligible:false};
  })
 };
}
