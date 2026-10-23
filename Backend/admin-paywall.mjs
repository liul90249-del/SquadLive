const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={free7:'7 天免费',intro099:'首 7 天 $0.99',intro199:'首 7 天 $1.99',intro399:'首 7 天 $3.99',intro699:'首 7 天 $6.99'};
const templateLabels={storage:'存储清理展示',compact:'精简付费页',comparison:'周／年方案对比'};
function previewHTML(p){
  const free=p.selectedTier==='free7',intro=labels[p.selectedTier]||'待选择';
  return `<div style="display:flex;gap:24px;flex-wrap:wrap;padding:24px;background:#f5f8fc;border-radius:20px;margin:16px 0" data-policy-preview>
    <div style="flex:0 1 280px;border:1px solid #dbe2ec;border-radius:28px;background:white;padding:24px;box-shadow:0 8px 24px #14233a0d">
      <small>布局示意 · ${esc(templateLabels[p.template])}</small>
      <h3>${p.template==='storage'?'清理你的存储':'Clean Pro'}</h3>
      ${p.template==='storage'?'<p>照片整理 · 视频压缩</p><div style="height:12px;border-radius:8px;background:linear-gradient(90deg,#63bbfb,#8057ed)"></div>':''}
      <p>解锁全部清理功能</p>
      <div style="padding:12px;border:2px solid #2374ed;border-radius:12px"><strong>${esc(intro)}</strong><br><small>之后 $9.99／周，自动续费</small></div>
      ${p.template==='comparison'?'<div style="padding:12px;margin-top:8px;border:1px solid #dbe2ec;border-radius:12px">年度订阅<br><small>显示苹果返回的实际年费</small></div>':''}
      <div style="background:#1677ff;color:white;text-align:center;padding:12px;border-radius:12px;margin-top:18px">${free?'免费试用':'开始订阅'}</div>
      <small>恢复购买 · 隐私政策 · 服务条款</small>
    </div>
    <div style="flex:1;min-width:240px"><h3>当前草稿将如何展示</h3><p>${p.enabled?'面向符合版本、地区和优惠资格的用户展示所选方案。':'远程配置已停用；此处仅预览草稿，App 继续使用默认方案。'}</p><p>首期：${esc(intro)}；第二周起：$9.99／周。</p><p>不符合苹果首期优惠资格的用户显示正常价格，不承诺免费或低价首周。此处为美国区布局示意，实际价格与资格由苹果返回。</p><p>${p.surprise.enabled?`惊喜特惠：至少访问 ${p.surprise.minVisits} 次；距上次访问至少 ${p.surprise.minIntervalHours} 小时；关闭后 ${p.surprise.dismissCooldownHours} 小时内不再弹出；每 24 小时最多 ${p.maxMarketingPer24Hours} 次，每 7 天最多 ${p.surprise.maxPer7Days} 次。`:'惊喜特惠已关闭。'}</p></div>
  </div>`;
}
let state=null,working=null,dirty=false,busy=false,message='';
export const paywallEditing=()=>dirty||busy;
export function paywallHTML(next){
  if(!next)return '';
  if(!dirty&&!busy&&(!state||next.revision>=state.revision)){state=structuredClone(next);working=structuredClone(next.draft);}
  const p=working;
  const history=[state.published,...(state.history||[])].filter(Boolean);
  const option=(v,label,selected)=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(label)}</option>`;
  const number=(key,label,min,max)=>`<label>${label}<input data-policy="surprise.${key}" type="number" min="${min}" max="${max}" step="1" value="${p.surprise[key]}"></label>`;
  return `<section class="insight-surface" data-paywall-editor><header><div><h2>付费模板与首期方案</h2><p>草稿版本 ${state.revision} · 已发布 ${state.published?.revision??'无'} · 金额以苹果商品为准</p></div></header>
  <div class="insight-filters"><label>远程配置<select data-policy="enabled">${option('false','停用，使用 App 默认方案',String(p.enabled))}${option('true','启用已核对的方案',String(p.enabled))}</select></label>
  <label>首期档位<select data-policy="selectedTier">${Object.entries(labels).map(([v,l])=>option(v,l,p.selectedTier)).join('')}</select></label>
  <label>付费页模板<select data-policy="template">${[['storage','存储清理展示'],['compact','精简付费页'],['comparison','周／年方案对比']].map(([v,l])=>option(v,l,p.template)).join('')}</select></label>
  <label>最低 App 版本<input data-policy="minAppVersion" value="${esc(p.minAppVersion)}" maxlength="11"></label></div>
  <p class="scope-note">五档均保留。付费首期为 7 天，美国区后续按 $9.99／周续费。编辑不会立即生效；发布前需核对苹果商品。已订阅用户不因切换配置而改价。</p>
  ${previewHTML(p)}
  <details><summary>苹果商品映射（高级配置）</summary><div class="insight-table"><table><thead><tr><th>首期方案（美国区 USD）</th><th>苹果商品 ID</th><th>苹果订阅资源 ID</th><th>销售地区</th></tr></thead><tbody>${p.tiers.map((t,i)=>`<tr><td>${labels[t.id]}</td><td><input aria-label="${labels[t.id]}商品 ID" data-tier="${i}" data-tier-key="productId" value="${esc(t.productId)}" placeholder="待配置苹果商品" style="min-width:340px"></td><td><input aria-label="${labels[t.id]}苹果订阅资源 ID" data-tier="${i}" data-tier-key="appleSubscriptionId" value="${esc(t.appleSubscriptionId)}" placeholder="苹果后台数字 ID"></td><td><input aria-label="${labels[t.id]}销售地区" data-tier="${i}" data-tier-key="territories" value="${esc(t.territories.join(','))}" placeholder="USA"></td></tr>`).join('')}</tbody></table></div></details>
  <div class="insight-filters"><label>惊喜特惠<select data-policy="surprise.enabled">${option('false','关闭',String(p.surprise.enabled))}${option('true','按策略展示',String(p.surprise.enabled))}</select></label>
  ${number('minVisits','至少主动访问付费页次数',1,100)}${number('minIntervalHours','与上次付费页间隔（小时）',1,720)}${number('dismissCooldownHours','特惠关闭后冷却（小时）',1,720)}${number('maxPer7Days','每 7 天特惠上限',1,14)}
  <label>每 24 小时自动特惠上限<input data-policy="maxMarketingPer24Hours" type="number" min="1" max="5" value="${p.maxMarketingPer24Hours}"></label>
  <label>特惠苹果订阅资源 ID<input data-policy="surprise.appleSubscriptionId" value="${esc(p.surprise.appleSubscriptionId)}" placeholder="苹果后台数字 ID"></label><label>特惠商品 ID<input data-policy="surprise.productId" value="${esc(p.surprise.productId)}"></label></div>
  <p class="scope-note">关闭主付费页正常退出。有效会员不弹拉新促销；试用到期不自动改成年费。用户必须主动确认购买。</p>
  ${history.length?`<details><summary>发布历史 · 恢复以前的方案</summary><p class="scope-note">恢复只修改草稿，不会直接改变线上方案。重新核对并发布后生效。</p><div class="insight-filters"><label>已发布版本<select data-policy-history>${history.map(item=>option(item.revision,`版本 ${item.revision} · ${item.publishedAt} · ${labels[item.policy.selectedTier]||item.policy.selectedTier} · ${templateLabels[item.policy.template]||item.policy.template}`,state.published?.revision)).join('')}</select></label><button data-policy-action="restore" ${dirty||busy?'disabled':''}>恢复为草稿</button></div></details>`:''}
  <div class="insight-filters"><button data-policy-action="save" ${busy?'disabled':''}>保存草稿</button><button data-policy-action="publish" ${dirty||busy?'disabled':''}>核对并发布</button><button data-policy-action="discard" ${busy?'disabled':''}>放弃未保存修改</button><span role="status">${esc(message|| (dirty?'有未保存修改':'草稿与线上版本分开'))}</span></div></section>`;
}
function changed(){window.dispatchEvent(new Event('admin-paywall-change'));}
document.addEventListener('input',e=>{
  const el=e.target;if(!el.closest('[data-paywall-editor]')||busy)return;
  if(el.dataset.tier!==undefined){const t=working.tiers[Number(el.dataset.tier)];const k=el.dataset.tierKey;t[k]=k==='territories'?el.value.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean):el.value.trim();}
  else if(el.dataset.policy){const path=el.dataset.policy.split('.');const target=path.length===2?working[path[0]]:working;const key=path.at(-1);target[key]=el.type==='number'?Number(el.value):key==='enabled'?el.value==='true':el.value;}
  else return;
  dirty=true;message='有未保存修改';
  for(const preview of document.querySelectorAll('[data-policy-preview]'))preview.outerHTML=previewHTML(working);
  for(const root of document.querySelectorAll('[data-paywall-editor]')){root.querySelector('[data-policy-action="publish"]').disabled=true;const restore=root.querySelector('[data-policy-action="restore"]');if(restore)restore.disabled=true;root.querySelector('[role="status"]').textContent=message;}
});
document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-policy-action]');if(!button||busy)return;
  const action=button.dataset.policyAction;
  if((action==='publish'||action==='restore')&&dirty)return;
  const sourceRevision=action==='restore'?Number(button.closest('[data-paywall-editor]').querySelector('[data-policy-history]').value):null;
  if(action==='discard'){dirty=false;working=structuredClone(state.draft);message='已恢复已保存草稿';changed();return;}
  busy=true;message=action==='save'?'正在保存草稿…':action==='restore'?'正在恢复历史草稿…':'正在核对苹果商品…';changed();
  try{const result=await window.apiPost('/v1/admin/products/cleaner/paywall-policy',{action,revision:state.revision,...(action==='save'?{policy:working}:action==='restore'?{sourceRevision}:{})});state=result;working=structuredClone(result.draft);dirty=false;message=action==='save'?'草稿已保存，尚未改变线上方案':action==='restore'?'历史方案已恢复为草稿；核对并发布后生效':'发布成功';}
  catch(error){message=error.message||'操作失败，请重试';}
  finally{busy=false;changed();}
});
