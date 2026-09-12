import {mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const conflict=()=>Object.assign(new Error('Subscription ownership conflict; administrator review required'),{status:409});
const hash=value=>createHash('sha256').update(value).digest('hex');

// Called inside the inbox's serialized write queue, after Apple verification.
// Persist the reservation before the receipt: a crash can leave a reservation,
// but can never leave a recorded receipt whose subscription is free to rebind.
export async function reserveSubscriptionOwner(root,transaction,atomic){
  const path=join(root,'subscriptions');
  await mkdir(path,{recursive:true});
  const file=join(path,hash(transaction.original_id)+'.json');
  let owner;
  try{owner=JSON.parse(await readFile(file,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
  if(!owner){
    // Recover ownership from receipts written before this index existed.
    // Missing tokens deliberately remain unowned; they are not an invitation
    // to assign historical subscription revenue to a later account.
    const tokens=new Set();
    for(const entry of await readdir(root,{withFileTypes:true})){
      if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
      const receipt=JSON.parse(await readFile(join(root,entry.name),'utf8'));
      if(receipt.original_id===transaction.original_id)tokens.add(receipt.account_token||null);
    }
    if(tokens.size>1)throw conflict();
    owner={original_id:transaction.original_id,account_token:tokens.size?[...tokens][0]:transaction.account_token};
    await atomic(file,owner);
  }
  if(owner.original_id!==transaction.original_id)throw conflict();
  // Apple may omit a token on subsequent notifications. The stored owner stays
  // fixed; an explicitly different token must never replace it.
  if(transaction.account_token&&owner.account_token!==transaction.account_token)throw conflict();
  return owner.account_token;
}
