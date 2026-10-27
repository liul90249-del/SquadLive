const key=(product,section)=>`admin.preferences.v1.${product}.${section}`;
export function readPreference(product,section,storage) {
  try {storage??=globalThis.localStorage;const v=JSON.parse(storage?.getItem(key(product,section))||'null');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}
}
export function savePreference(product,section,value,storage) {
  try {storage??=globalThis.localStorage;storage?.setItem(key(product,section),JSON.stringify(value));}catch{/* Private browsing or full storage must not interrupt the dashboard. */}
}
