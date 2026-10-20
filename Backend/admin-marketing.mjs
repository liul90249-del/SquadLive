import {buildMarketingReport,dateOf,DAY} from './marketing-core.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>v===null||v===undefined?'—':(v/1000).toLocaleString('zh-CN',{maximumFractionDigits:2,minimumFractionDigits:2});
const pct=v=>v===null||v===undefined?'—':v.toFixed(1)+'%';
const ratio=(n,d)=>d>0?n/d*100:null;
const names={unknown:'归因未知',organic:'自然量',applovin:'AppLovin'};
const title=r=>[names[r.channel]||r.channel,r.campaignName||r.campaignId,r.adGroupName||r.adGroupId,r.creativeName||r.creativeId].filter(Boolean).join(' / ');
const help={
  spend:'已导入的广告花费；按 UTC 日期、所选币种与来源筛选。缺少成本记录显示 —，不视为免费获客。重复导入同一日期、广告层级和币种会更新原记录，不累加。',
  users:'按首次获客日期筛选的后台安装身份，包含自然量、已归因广告用户和归因未知用户。无归因时间时使用后台注册日期，并标明未知。不是广告平台报告安装数，也不是独立自然人。',
  paid:'所选获客批次中，截至目前首次观察到实际扣款的用户；7 天免费试用的 0 元订单不算。所有币种去重，退款不撤销首次付费身份。',
  net:'所选获客批次已关联用户的苹果验证扣款，减去目前已知退款，按所选币种计算；包含后续续费。不含苹果佣金与税费调整，不是到账或利润。未知归因和未绑定订单可能使渠道收入不完整。',
  ctr:'广告点击数 ÷ 展示数，来自导入报表。分母为 0 或未导入时显示 —。',
  cpi:'广告花费 ÷ 广告报表中的归因安装数。与后台首次打开人数是不同来源，不能直接等同。',
  cpp:'广告花费 ÷ 该获客批次中首次实际扣款的去重用户。包含免费试用结束后扣款，不包含仍在免费期的用户。成本或归因不完整时不计算。',
  trial:'仅使用苹果验证交易中明确标记 FREE_TRIAL 的试用记录，不把所有 0 元订单都当试用。到期转付费分母为已到苹果记录试用结束时间的用户，分子为同一订阅随后真实扣款者。仍在试用期及结束时间未知者不进入分母；不是最终固定转化率。',
  roas:'同一获客日期和广告来源的 D7/D14/D30 已关联净扣款 ÷ 当日对应广告花费。D7 为获客 UTC 日期起的 7 个自然日，D14/D30 同理。未满观察窗口显示“观察中”。后续退款回补原批次；不同币种不混算，不代表全量广告平台或 SKAN 估算 ROAS。',
  funnel:'按同一获客批次统计各阶段到达人数；每人每阶段一次，比例以有新版行为记录的用户为分母。阶段可以跳过或顺序不同，不把相邻数字相减当流失率。老版本未采集与更新后部分记录单列。清理行为是旁路，不要求先清理再订阅。',
  coverage:'广告报表安装数、后台身份数和 iOS 隐私汇总归因是不同口径。未知不能当自然量，也不能强行映射到某条素材。只有明确映射到后台用户 ID 的首次获客归因才能导入；SKAN 汇总数据不能导入用户明细。',
  window:'按获客日期回看后续收入，而不是把当天所有收入除以当天广告费。窗口内扣款减去截至当前已知退款。未关联用户的订单不分摊给广告。'
};
const h=(label,key)=>`<span class="market-label">${label}<button type="button" data-market="help" data-help="${key}" aria-label="${label}：投放指标说明" title="${esc(help[key])}">?</button></span>`;
const options=(values,selected)=>values.map(([v,n])=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(n)}</option>`).join('');
const table=(heads,rows)=>`<div class="market-table" tabindex="0" role="region" aria-label="广告投放数据表"><table><thead><tr>${heads.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${heads.length}">当前筛选下没有记录。调整筛选或导入真实数据后查看。</td></tr>`}</tbody></table></div>`;
const datasets=new Map(),states=new Map();
let activeProduct='';
export function marketingEditing(product) {
  return [...document.querySelectorAll('[data-market-product]')].some(el=>el.dataset.marketProduct===product&&el.getClientRects().length&&
    (el.querySelector('.market-import[open]')||el.contains(document.activeElement)&&document.activeElement.closest('form')));
}
function state(data) {
  if(!states.has(data.product))states.set(data.product,{start:dateOf(data.now-29*DAY),end:dateOf(data.now),currency:'USD',level:'campaign',channel:'',campaignId:'',adGroupId:'',creativeId:'',limit:30,importKind:'costs',csv:'',preview:null,message:''});
  return states.get(data.product);
}
function changed(){window.dispatchEvent(new Event('admin-marketing-change'));}
export function marketingHTML(data) {
  if(!data)return '<div class="insight-empty">广告数据接口尚未接入当前后台版本。</div>';
  activeProduct=data.product;datasets.set(data.product,data);const s=state(data),r=buildMarketingReport(data,s);
  const channels=[...new Set([...data.costs.map(c=>c.channel),...data.users.map(u=>u.attribution?.channel||'unknown')])].sort();
  const currencies=[...new Set(['USD',...data.costs.map(c=>c.currency),...data.orders.map(o=>o.currency).filter(Boolean)])].sort();
  const stageNames={onboarding_complete:'完成引导',photo_permission_granted:'照片已授权（含部分）',paywall_open:'看到订阅页',purchase_attempt:'点击购买',cleanup_completed:'成功清理',purchase_cancelled:'取消购买弹窗',purchase_failed:'购买失败',products_load_failed:'商品加载异常'};
  const stages=r.events.filter(e=>['onboarding_complete','photo_permission_granted','paywall_open','purchase_attempt'].includes(e.key));
  const errors=r.events.filter(e=>['cleanup_completed','purchase_cancelled','purchase_failed','products_load_failed'].includes(e.key));
  const preview=s.preview;
  const connection=data.applovin;
  return `<div class="marketing-workspace" data-market-product="${esc(data.product)}">
  <section class="insight-surface market-intro"><header><div><h2>广告投放</h2><p>从获客到真实扣款，查看每一批用户的回本进度</p></div><span class="status-badge">${data.costs.length?'已导入成本':'成本未接入'}</span></header>
  <p class="scope-note">全部日期为 UTC · 北京时间 08:00 结束上一统计日 · 金额按原币种分开 · 当前渠道收益仅覆盖已关联用户，非全量平台归因估算。</p>
  <form id="marketingFilters" class="insight-filters"><label>获客开始<input type="date" name="start" value="${s.start}" required></label><label>获客结束<input type="date" name="end" value="${s.end}" required></label><label>渠道<select name="channel">${options([['','全部渠道'],...channels.map(c=>[c,names[c]||c])],s.channel)}</select></label><label>查看层级<select name="level">${options([['channel','渠道'],['campaign','广告系列'],['adGroup','广告组'],['creative','广告素材']],s.level)}</select></label><label>收入与成本币种<select name="currency">${options(currencies.map(c=>[c,c]),s.currency)}</select></label><button type="submit" class="primary">查看</button><button type="button" data-market="reset">重置</button></form>
  ${s.campaignId?`<p class="market-breadcrumb">当前路径：${esc(s.channel)} / ${esc(s.campaignId)} ${esc(s.adGroupId)} ${esc(s.creativeId)} <button data-market="clear-path">返回全部层级</button></p>`:''}</section>
  ${data.product==='cleaner'?`<section class="insight-surface market-connection"><details ${s.connectionOpen?'open':''}><summary>AppLovin 数据连接<span class="status-badge">${connection?.configured?(connection.enabled?'自动同步已启用':'已配置 · 自动同步关闭'):'等待服务器配置'}</span></summary><div><p>广告花费 → 展示 → 点击 → 安装，由 AppLovin 广告主报表读取。每次更新最近 7 个完整 UTC 日，启用后北京时间 08:00 自动核对；失败会保留原数据并重试。</p><p class="scope-note">AppLovin 素材组显示在“广告组”层；单条素材成本未接入时不分摊。用户归因仍需 Singular 等来源与后台用户 ID 关联，广告安装数不会直接变成后台用户数。</p><p>${connection?.lastSuccess?'最近成功：'+esc(new Date(connection.lastSuccess).toISOString())+' · '+connection.rows+' 行':'尚未完成真实账户同步'}${connection?.currency?' · '+esc(connection.currency):''}</p>${connection?.error?`<p role="alert">${esc(connection.error)}</p>`:''}<button data-market="sync-applovin" ${!connection?.configured||document.body.dataset.demo?'disabled':''}>立即核对 AppLovin 成本</button><p role="status">${esc(s.syncMessage||'')}</p></div></details></section>`:''}
  <div class="market-kpis">${[['广告花费','spend',r.totals.spend===null?'未接入':`${s.currency} ${money(r.totals.spend)}`],['后台获客身份','users',r.totals.users],['首次实际扣款人数','paid',r.totals.paid],['已关联净扣款','net',`${s.currency} ${money(r.totals.net)}`]].map(([label,key,value])=>`<section>${h(label,key)}<strong>${value}</strong></section>`).join('')}</div>
  <section class="insight-surface"><header><h2>用户路径</h2>${h('阶段到达率','funnel')}</header>
  <p class="scope-note">展示 ${r.totals.impressions??'—'} → 点击 ${r.totals.clicks??'—'} → 广告报表安装 ${r.totals.installs??'—'}。以下为所选获客批次后台身份，不与报表安装强行一一对应。</p>
  <div class="market-path"><div><small>后台首次会话</small><strong>${r.totals.users}</strong><span>新安装身份</span></div>${stages.map(e=>`<div><small>${stageNames[e.key]}</small><strong>${e.count??'—'}</strong><span>${pct(e.rate)} · 已采集 ${e.denominator} 人</span></div>`).join('')}<div><small>已验证免费试用</small><strong>${r.trial.started}</strong><span>仅明确的试用订单</span></div><div><small>首次实际扣款</small><strong>${r.totals.paid}</strong><span>不含 0 元试用</span></div></div>
  <div class="market-secondary">${errors.map(e=>`<span>${stageNames[e.key]} <b>${e.count??'未采集'}</b></span>`).join('')}</div>
  <p class="scope-note">行为未采集 ${r.quality.funnelUnknown} 人 · 更新后才开始采集 ${r.quality.funnelPartial} 人。旁路行为不强制先后，首次发生记录不代表当天发生次数。</p></section>
  <section class="insight-surface"><header><h2>渠道与素材表现</h2><button data-market="export">导出当前获客表 CSV</button></header><p class="scope-note">点击来源继续下钻。只导入系列成本时，素材层不会分摊或编造花费。${h('归因范围','coverage')}</p>
  ${table(['来源',h('花费','spend'),'展示','点击',h('点击率','ctr'),'报表安装',h('安装成本','cpi'),h('后台身份','users'),'试用',h('实际付费','paid'),h('首次付费成本','cpp'),h('已关联净扣款','net')],r.groups.map((g,i)=>`<tr><td><button class="market-link" data-market="drill" data-row="${i}">${esc(title(g))}</button></td><td>${g.costRows?money(g.spend):'未导入'}${g.missingCostCohorts?'<small>部分日期缺成本</small>':''}</td><td>${g.costRows?g.impressions:'—'}</td><td>${g.costRows?g.clicks:'—'}</td><td>${pct(g.costRows?ratio(g.clicks,g.impressions):null)}</td><td>${g.costRows?g.installs:'—'}</td><td>${money(g.costRows&&g.installs?g.spend/g.installs:null)}</td><td>${g.users}</td><td>${g.trial}</td><td>${g.paid}</td><td>${money(g.costRows&&!g.missingCostCohorts&&g.paid?g.spend/g.paid:null)}</td><td>${money(g.net)}</td></tr>`))}</section>
  <section class="insight-surface"><header><h2>获客批次与回本</h2>${h('D7 / D14 / D30','roas')}</header><p class="scope-note">按获客日期从近到远排列。窗口内净扣款随后续退款回补；观察期未结束时不下回本结论。</p>
  ${table(['获客日 / 来源','后台身份','花费',...['D7','D14','D30'].map(x=>h(x+' 净扣款 / ROAS','window'))],r.cohorts.slice(0,s.limit).map(c=>`<tr><td><b>${c.date}</b><small>${esc(title(c))}</small></td><td>${c.acquiredUsers}</td><td>${c.cost?money(c.cost.spendMilliunits):'未导入'}</td>${[7,14,30].map(n=>`<td>${money(c.windows[n].net)}<small>${!c.windows[n].mature?'观察中':c.windows[n].roas===null?'成本或关联用户不足':pct(c.windows[n].roas)}</small></td>`).join('')}</tr>`))}
  <footer class="insight-pagination"><span>已展示 ${Math.min(s.limit,r.cohorts.length)} / ${r.cohorts.length} 批</span>${s.limit<r.cohorts.length?'<button data-market="more">加载更早 30 批</button>':''}</footer></section>
  <div class="market-bottom"><section class="insight-surface"><header><h2>试用转付费</h2>${h('计算方式','trial')}</header><div class="market-trial"><strong>${pct(r.trial.rate)}</strong><p>${r.trial.converted} 人实际扣款 / ${r.trial.ended} 人已结束试用</p><p>试用中 ${r.trial.pending} 人 · 结束时间未知 ${r.trial.unknownEnd} 人</p></div><p class="scope-note">不是“全部订阅转付费率”。历史未保存试用类型的交易不推断为试用；需苹果新交易或重新核对补齐。</p></section>
  <section class="insight-surface"><header><h2>数据完整性</h2>${h('为什么有缺口','coverage')}</header><ul class="market-quality"><li>归因未知 <b>${r.quality.unknownAttribution} 人</b></li><li>未绑定用户的订单（购买日口径） <b>${r.quality.unlinkedOrders} 笔</b></li><li>金额或币种未知 <b>${r.quality.unknownAmounts} 笔</b></li><li>其他币种扣款（未并入当前金额） <b>${r.quality.mixedCurrencyOrders} 笔</b></li><li>收入归因上报待核对 <b>${r.quality.attributionDeliveryIssues} 笔</b></li></ul><p class="scope-note">这里只展示已同步或已导入记录；账户连接状态见上方。缺失成本、归因和行为记录需补齐后再评估渠道效果。</p></section></div>
  <section class="insight-surface"><details class="market-import" ${s.importOpen?'open':''}><summary>接入广告成本与首次获客归因</summary><p>先下载标准模板，将广告平台 / Singular 导出数据转换到模板列名。成本只接受 UTC、一个固定层级；归因仅接受已映射的后台用户 ID，不接受 SKAN 汇总推断。先预览，确认后才保存。编辑期间暂停页面自动重绘，收起后恢复。</p>
  <form id="marketingImport"><label>导入类型<select name="kind">${options([['costs','每日广告成本'],['attribution','首次获客归因']],s.importKind)}</select></label><button type="button" data-market="template">下载当前模板</button><label>选择 CSV<input name="file" type="file" accept=".csv,text/csv"></label><label>CSV 内容<textarea name="csv" rows="5" spellcheck="false" placeholder="粘贴 CSV 或选择文件">${esc(s.csv)}</textarea></label><button type="submit">校验并预览</button></form>
  <div role="status" class="market-import-result">${esc(s.message)}</div>
  ${preview?`<div class="market-preview"><p>校验通过：${preview.count} 行，新增 ${preview.added} 行，覆盖更新 ${preview.replaced} 行。</p>${preview.totals?`<p>本次花费：${Object.entries(preview.totals).map(([c,v])=>esc(c)+' '+money(v)).join(' · ')}</p>`:''}<pre>${esc(JSON.stringify(preview.records,null,2))}</pre><button type="button" class="primary" data-market="save-import" ${document.body.dataset.demo?'disabled':''}>确认保存导入</button>${document.body.dataset.demo?'<p>演示页仅校验，不保存业务数据。</p>':''}</div>`:''}
  <h3>最近同步 / 导入</h3>${data.imports.length?`<ul>${data.imports.map(i=>`<li>${esc(new Date(i.at).toISOString().replace('T',' ').slice(0,19))} UTC · ${i.kind==='costs'?'广告成本':'首次归因'} · ${i.count} 行（更新 ${i.replaced}）</li>`).join('')}</ul>`:'<p>尚无导入记录。</p>'}</details></section></div>`;
}
const dialog=document.createElement('dialog');dialog.className='insight-dialog';document.body.append(dialog);
function download(name,text){const a=document.createElement('a'),url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/csv;charset=utf-8'}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const headers={
  costs:'date,timezone,channel,campaignId,campaignName,adGroupId,adGroupName,creativeId,creativeName,currency,spend,impressions,clicks,installs',
  attribution:'accountId,acquiredAt,channel,campaignId,campaignName,adGroupId,adGroupName,creativeId,creativeName,source'
};
document.addEventListener('toggle',event=>{
  if(!event.target.matches('.market-import,.market-connection details')||!event.target.isConnected||!event.target.getClientRects().length)return;
  const scope=event.target.closest('[data-market-product]');
  if(scope&&datasets.has(scope.dataset.marketProduct)){const s=state(datasets.get(scope.dataset.marketProduct));s[event.target.matches('.market-import')?'importOpen':'connectionOpen']=event.target.open;}
},true);
document.addEventListener('click',async event=>{
  const b=event.target.closest('[data-market]');if(!b)return;
  if(b.dataset.market==='close-help'){dialog.close();return;}
  if(b.dataset.market==='help'){dialog.innerHTML=`<header><h2>投放指标说明</h2><button data-market="close-help">关闭</button></header><p class="metric-explanation">${esc(help[b.dataset.help])}</p>`;dialog.showModal();return;}
  const scope=b.closest('[data-market-product]');if(!scope)return;
  const product=scope.dataset.marketProduct,data=datasets.get(product);if(!data)return;
  const s=state(data),action=b.dataset.market;
  if(action==='template'){const kind=scope.querySelector('[name="kind"]').value;download(`${product}-${kind}-template.csv`,headers[kind]+'\n');return;}
  if(action==='sync-applovin'){
    if(document.body.dataset.demo||!data.applovin?.configured)return;
    b.disabled=true;s.syncMessage='正在核对最近 7 个完整统计日…';
    try{
      await window.apiPost('/v1/admin/products/cleaner/applovin-sync',{});
      s.syncMessage='AppLovin 成本已更新。';
      if(activeProduct===product&&document.getElementById('productPicker').value===product)document.getElementById('refresh').click();
    }catch(e){s.syncMessage=e.message;}
    changed();return;
  }
  if(action==='more')s.limit+=30;
  if(action==='clear-path'){s.channel='';s.campaignId='';s.adGroupId='';s.creativeId='';}
  if(action==='reset'){states.delete(product);}
  if(action==='drill'){
    const row=buildMarketingReport(data,s).groups[Number(b.dataset.row)];if(!row)return;
    s.channel=row.channel;
    if(s.level==='channel')s.level='campaign';
    else if(s.level==='campaign'&&row.campaignId){s.campaignId=row.campaignId;s.level='adGroup';}
    else if(s.level==='adGroup'&&row.adGroupId){s.campaignId=row.campaignId;s.adGroupId=row.adGroupId;s.level='creative';}
    else {s.campaignId=row.campaignId||'';s.adGroupId=row.adGroupId||'';s.creativeId=row.creativeId||'';}
    s.limit=30;
  }
  if(action==='export'){
    const csv=v=>{let t=String(v??'');if(/^[=+\-@\t\r]/.test(t))t="'"+t;return '"'+t.replaceAll('"','""')+'"';};
    const rows=buildMarketingReport(data,s).cohorts.map(c=>[c.date,title(c),s.currency,c.acquiredUsers,c.cost?c.cost.spendMilliunits/1000:'',...[7,14,30].flatMap(n=>[c.windows[n].net/1000,c.windows[n].mature?'完整':'观察中',c.windows[n].roas??''])]);
    download(`${product}-acquisition.csv`,[['UTC获客日','来源','币种','后台身份','花费','D7净扣款','D7窗口','D7ROAS百分比','D14净扣款','D14窗口','D14ROAS百分比','D30净扣款','D30窗口','D30ROAS百分比'],...rows].map(r=>r.map(csv).join(',')).join('\r\n'));return;
  }
  if(action==='save-import'){
    if(document.body.dataset.demo||!s.preview)return;
    b.disabled=true;
    try{
      await window.apiPost(`/v1/admin/products/${product}/marketing-import`,{kind:s.importKind,csv:s.csv,confirm:true,fingerprint:s.preview.fingerprint});
      s.preview=null;s.message='导入已保存。';s.csv='';s.importOpen=false;
      scope.querySelector('.market-import').open=false;
      // Refresh using the existing authenticated and product-guarded data loader.
      if(activeProduct===product&&document.getElementById('productPicker').value===product)document.getElementById('refresh').click();
    }catch(e){s.message=e.message;}
  }
  changed();
});
document.addEventListener('change',async event=>{
  const form=event.target.closest('#marketingImport');if(!form)return;
  const product=form.closest('[data-market-product]').dataset.marketProduct,s=state(datasets.get(product));
  if(event.target.name==='kind'){s.importKind=event.target.value;s.preview=null;s.message='';s.csv='';changed();}
  if(event.target.name==='file'){
    const file=event.target.files[0];if(!file)return;
    if(file.size>700000){s.message='文件需小于 700 KB';changed();return;}
    s.csv=await file.text();s.preview=null;s.message='文件已读取，请校验预览。';changed();
  }
});
document.addEventListener('input',event=>{
  const filters=event.target.closest('#marketingFilters');if(filters){filters.elements.end.setCustomValidity('');return;}
  if(event.target.name!=='csv')return;const scope=event.target.closest('[data-market-product]');if(!scope)return;
  const s=state(datasets.get(scope.dataset.marketProduct));s.csv=event.target.value;s.preview=null;
  scope.querySelector('.market-preview')?.remove();
});
document.addEventListener('submit',async event=>{
  if(!['marketingFilters','marketingImport'].includes(event.target.id))return;
  event.preventDefault();const form=event.target,product=form.closest('[data-market-product]').dataset.marketProduct,data=datasets.get(product),s=state(data),f=new FormData(form);
  if(form.id==='marketingFilters'){
    if(String(f.get('start'))>String(f.get('end'))){form.elements.end.setCustomValidity('结束不能早于开始');form.elements.end.reportValidity();return;}
    form.elements.end.setCustomValidity('');
    if(s.channel!==f.get('channel')){s.campaignId='';s.adGroupId='';s.creativeId='';}
    for(const k of ['start','end','channel','currency','level'])s[k]=String(f.get(k));s.limit=30;changed();return;
  }
  s.importKind=String(f.get('kind'));s.csv=String(f.get('csv'));s.message='正在校验…';s.preview=null;
  const captured=s.csv,kind=s.importKind;
  form.querySelector('button[type="submit"]').disabled=true;
  try{
    const preview=await window.apiPost(`/v1/admin/products/${product}/marketing-import`,{kind,csv:captured});
    if(s.csv===captured&&s.importKind===kind){s.preview=preview;s.message='预览完成，尚未保存。';}
  }catch(e){s.message=e.message;}changed();
});
