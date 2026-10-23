import {paywallHTML,paywallEditing} from './admin-paywall.mjs';
import {marketingHTML,marketingEditing} from './admin-marketing.mjs';
import {dateOf,shiftDay,period,aggregate,delta,filterUsers,filterOrders,needsReview,pageRows} from './admin-insights-core.mjs';
import {subscriptionPanelHTML,metricLabel,metricHelp} from './admin-subscriptions.mjs';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => Number(v || 0).toLocaleString('zh-CN',{maximumFractionDigits:1});
const amount = v => (Number(v || 0)/1000).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:3});
const money = (v,c) => `${esc(c)} ${amount(v)}`;
const time = v => v ? esc(new Date(v).toISOString().replace('T',' ').slice(0,16)) : '未记录';
const picker = $('productPicker');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let lastScene = '';
function revealWorkspace() {
  const scene = `${picker.value}:${view}`;
  const changed = scene !== lastScene;
  lastScene = scene;
  if (reducedMotion.matches || document.hidden) return;
  const targets = changed
    ? host.querySelectorAll('.workspace-heading, .insight-filters, .insight-metric, .insight-surface')
    : host.querySelectorAll('.insight-table, .user-board, .trend-panel svg');
  targets.forEach((el,i)=>el.animate(
    [{opacity:0,transform:`translateY(${changed?8:3}px)`},{opacity:1,transform:'translateY(0)'}],
    {duration:changed?280:180,delay:changed?Math.min(i*45,180):0,easing:'cubic-bezier(.2,.8,.2,1)'}));
}

const host = document.createElement('div'); host.id = 'insightWorkspace'; $('section-product').prepend(host);
const dialog = document.createElement('dialog'); dialog.className = 'insight-dialog'; document.body.append(dialog);
const viewPanels = {overview:'productCardsPanel',trends:'productDailyPanel',users:'productUsersPanel',orders:'productOrdersPanel',prices:'productPricesPanel',marketing:'productMarketingPanel'};
const viewFromHash = () => Object.keys(viewPanels).find(key=>'#'+viewPanels[key]===location.hash) || 'overview';
const initialView = viewFromHash();
let snapshot, data, view = initialView, metric = 'registrations', currency = '', start = '', end = '', page = 1;
let query = '', status = 'all', sort = 'newest', dateField = 'purchasedAt', listStart = '', listEnd = '', orderCurrency = '', userMode = 'table';
let liveToday = false, receivedAt = null;
let selectedDay = '', lastProduct = '', loading = false, exactAccount = '', exactSku = '';
const titles = {overview:'运营概览',trends:'趋势分析',users:'用户明细',orders:'订阅与订单',prices:'商品与价格',marketing:'广告投放'};
const metrics = {registrations:'新增注册',activeUsers:'日均活跃',paidOrders:'实付订单',refunds:'退款事件',gross:'扣款金额'};
const btn = (text,action,extra='') => `<button type="button" data-action="${action}" ${extra}>${text}</button>`;
const option = (value,text,current) => `<option value="${esc(value)}" ${value===current?'selected':''}>${esc(text)}</option>`;
const currencies = () => [...new Set([...(data.orders || []).map(o=>o.currency),...Object.keys(data.totals.grossMilliunitsByCurrency || {})].filter(Boolean))].sort();
const table = (heads,rows) => rows.length ? `<div class="insight-table" tabindex="0" role="region" aria-label="${titles[view]}表格"><table><thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="insight-empty">没有符合条件的数据。可调整日期、状态或关键词。</div>';
function setView(next, reset=true) {
  view = titles[next] ? next : 'overview';
  const url=new URL(location.href);url.hash=viewPanels[view];history.replaceState(null,'',url);
  if(reset) {exactAccount='';exactSku='';query='';status='all';page=1;listStart='';listEnd='';orderCurrency='';dateField='purchasedAt';}
  selectedDay='';
  const keys = Object.keys(titles);
  document.querySelectorAll('.product-nav a').forEach((link,i)=>{
    if(keys[i]===view) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  });
  render();
}
function periodControl() {
  return `<form id="insightPeriod" class="insight-filters"><div class="range-presets">${btn('今日 · 实时','today',`aria-pressed="${liveToday}"`)}${[7,14,30].map(n=>btn(`近 ${n} 天`,'range',`data-days="${n}" aria-pressed="${!liveToday&&start===shiftDay(end,1-n)}"`)).join('')}</div><label>开始日期<input name="start" type="date" value="${start}" min="${data.daily[0]?.date || ''}" max="${end}" required></label><label>结束日期<input name="end" type="date" value="${end}" min="${start}" max="${data.daily.at(-1)?.date || ''}" required></label><button type="submit" class="primary">应用日期</button><span>${liveToday?`当天累计 · 每 30 秒自动刷新<br>更新于 ${receivedAt?new Date(receivedAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—'}（北京时间）<br>统计日 UTC · 北京时间 08:00 换日；上报可能延迟`:'UTC · 最后一天可能尚未结束'}</span></form>`;
}
function chart(rows,key) {
  if(!rows.length) return '<div class="insight-empty">此区间无趋势记录</div>';
  const values=rows.map(r=>key==='gross' ? Number(r.grossMilliunitsByCurrency?.[currency] || 0)/1000 : Number(r[key] || 0));
  const max=Math.max(1,...values), left=48, right=850, top=22, bottom=200;
  const x=i=>left+(right-left)*i/Math.max(1,rows.length-1), y=v=>bottom-(bottom-top)*v/max;
  const points=values.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  return `<svg viewBox="0 0 880 238" role="group" aria-label="${esc(key==='activeUsers'?'每日活跃':metrics[key])}，${start} 至 ${end}；逐日数值可点击下方日期查看"><g class="chart-grid">${[0,.5,1].map(t=>`<line x1="48" x2="850" y1="${y(max*t)}" y2="${y(max*t)}"/><text x="38" y="${y(max*t)+4}" text-anchor="end">${num(max*t)}</text>`).join('')}</g><polygon points="48,200 ${points} ${x(rows.length-1)},200" fill="#236de914"/><polyline points="${points}" fill="none" stroke="#236de9" stroke-width="3"/><line class="chart-cursor" x1="48" x2="48" y1="18" y2="200" hidden/>${values.map((v,i)=>`<g class="chart-point" tabindex="0" role="button" data-action="day" data-date="${rows[i].date}" data-x="${x(i)}" aria-pressed="${rows[i].date===selectedDay}" aria-label="${rows[i].date}，${key==='gross'?esc(currency)+' '+v.toFixed(2):num(v)}，查看当天数据"><circle class="chart-hit" cx="${x(i)}" cy="${y(v)}" r="15" fill="transparent"/><circle class="chart-dot" cx="${x(i)}" cy="${y(v)}" r="4" fill="#236de9"/><g class="chart-tooltip" aria-hidden="true" transform="translate(${Math.min(714,Math.max(48,x(i)-70))},${Math.max(3,y(v)-48)})"><rect width="140" height="36" rx="8"/><text x="70" y="23" text-anchor="middle">${rows[i].date.slice(5)} · ${key==='gross'?esc(currency)+' '+v.toFixed(2):num(v)}</text></g></g>`).join('')}<text x="48" y="226">${rows[0].date.slice(5)}</text><text x="850" y="226" text-anchor="end">${rows.at(-1).date.slice(5)}</text></svg>`;
}
function trendPanel(p) {
  const selected = p.current.find(r=>r.date===selectedDay);
  return `<section class="insight-surface trend-panel"><header><div><h2>每日变化</h2><p>${start} — ${end}${metric==='gross'?` · ${esc(currency)}`:' · 按天统计'}</p></div><label class="visually-hidden" for="trendMetric">趋势指标</label><select id="trendMetric">${Object.entries(metrics).map(([k,v])=>option(k,k==='activeUsers'?'每日活跃':v,metric)).join('')}</select>${metric==='gross'?`<select id="trendCurrency" aria-label="趋势币种">${currencies().map(c=>option(c,c,currency)).join('')}</select>`:''}</header>${metric==='gross'&&!currency?'<div class="insight-empty">暂无已验证金额</div>':chart(p.current,metric)}<div class="day-strip" aria-label="查看每日数据">${p.current.map(r=>btn(`${r.date.slice(5)} <b>${metric==='gross'?num((r.grossMilliunitsByCurrency?.[currency]||0)/1000):num(r[metric])}</b>`,'day',`data-date="${r.date}" aria-pressed="${r.date===selectedDay}"`)).join('')}</div><div class="day-detail" aria-live="polite">${selected?`${selected.date}：注册 ${selected.registrations} · 活跃 ${selected.activeUsers} · 实付订单 ${selected.paidOrders} · 退款 ${selected.refunds} ${btn('查看当天订单','day-orders')}`:'点击日期查看当天数值与订单。'}</div></section>`;
}
function summary(p) {
  return `<div class="insight-metrics">${['registrations','activeUsers','paidOrders','refunds'].map(k=>`<div class="metric-card-wrap"><button class="insight-metric" data-action="metric" data-key="${k}"><span>${liveToday&&k==='activeUsers'?'今日活跃':metrics[k]}</span><strong>${num(aggregate(p.current,k))}<em>${k==='activeUsers'?(liveToday?'人':'人 / 天'):k==='registrations'?'个身份':'笔'}</em></strong><p>${liveToday?'今日尚未结束 · 累计至本次更新':delta(aggregate(p.current,k),aggregate(p.previous,k),p.comparable)}</p></button>${metricHelp(liveToday&&k==='activeUsers'?'dailyActive':k,liveToday&&k==='activeUsers'?'今日活跃':metrics[k])}</div>`).join('')}</div>`;
}
function overview(p) {
  const totals=data.totals, cs=currencies();
  const subscriptionGap=data.subscriptions?.sync?.status==='unconfigured'?'<section class="insight-surface" role="alert"><h2>订阅数据需要补齐配置</h2><p>苹果订阅状态每日核对尚未启用，关闭续订数据可能不完整。需要为 Smart Cleaner 配置苹果订阅查询凭据。</p>'+btn('查看订阅核对状态','subscription-status')+'</section>':'';
  const refunds=data.orders.filter(o=>o.refunded), review=data.orders.filter(needsReview);
  return `${subscriptionGap}${summary(p)}<div class="insight-main-grid">${trendPanel(p)}<section class="insight-surface attention"><header><h2>需要关注</h2><span>全部记录</span></header><button data-action="review"><span class="attention-number">${review.length}</span><div><b>归因待核对</b><p>查看扣款或退款上报异常 →</p></div></button><button data-action="refund"><span class="attention-number">${refunds.length}</span><div><b>退款订单</b><p>包含全额与部分退款 →</p></div></button><div class="attention-note">${data.subscriptionCatalog ? `${esc($('productSubscriptionCatalog').textContent)}`:'统计基于已接入的身份与已验证订单。暂无额外服务告警数据。'}</div></section></div><div class="insight-bottom-grid"><section class="insight-surface"><header><h2>区间扣款</h2><span>分币种 · 未扣退款</span></header>${cs.length?cs.map(c=>`<button class="currency-row" data-action="currency" data-currency="${esc(c)}"><span>${esc(c)}</span><strong>${money(aggregate(p.current,'gross',c),c)}</strong><small>${liveToday?'今日累计':delta(aggregate(p.current,'gross',c),aggregate(p.previous,'gross',c),p.comparable)} →</small></button>`).join(''):'<div class="insight-empty">暂无已验证扣款</div>'}</section><section class="insight-surface retention"><header><h2>留存与累计规模</h2><span>累计口径 · 不随日期筛选</span></header>${[['次日留存',totals.day1Retention],['7 日留存',totals.day7Retention]].map(([label,r])=>`<div class="retention-row"><span>${metricLabel(label,label==='次日留存'?'day1':'day7')}</span><strong>${r.rate===null?'样本不足':`${r.rate}%`}</strong><span>${r.returned} / ${r.eligible} 个合格样本</span><meter min="0" max="100" value="${r.rate || 0}" aria-label="${label}"></meter></div>`).join('')}<p class="scope-note">累计注册 ${num(totals.registrations)} · 当前净付费 ${num(totals.payingUsers)}<br>留存只统计注册起有完整记录且已满观察期的身份。</p></section></div>`;
}
function trends(p) {
  return `${summary(p)}${trendPanel(p)}<section class="insight-surface"><header><h2>每日明细</h2><span>金额按原币种显示</span></header>${table([metricLabel('日期 UTC','date'),metricLabel('注册','registrations'),metricLabel('活跃','dailyActive'),metricLabel('付费用户','dailyPaying'),metricLabel('实付订单','paidOrders'),metricLabel('退款','refunds'),metricLabel('扣款金额','gross')],p.current.slice().reverse().map(r=>`<tr><td>${r.date}</td><td>${r.registrations}</td><td>${r.activeUsers}</td><td>${r.payingUsers}</td><td>${r.paidOrders}</td><td>${r.refunds}</td><td>${Object.entries(r.grossMilliunitsByCurrency).map(([c,v])=>money(v,c)).join(' · ')||'—'}</td></tr>`))}</section>`;
}
function filters() {
  const users=view==='users';
  return `<form id="insightSearch" class="insight-filters list-filters"><label class="search-label">${users?'用户 ID / 设备 ID / 地区 / IP':'交易 / 用户 / 商品'}<input name="query" value="${esc(query)}" placeholder="输入关键词" type="search"></label><label>状态<select name="status">${(users?[['all','全部用户'],['paid','有净实付订单'],['unpaid','无净实付订单']]:[['all','全部订单'],['charged','实付订单'],['refund','有退款'],['review','归因待核对']]).map(([k,v])=>option(k,v,status)).join('')}</select></label>${users?`<label>排序<select name="sort">${[['newest','注册时间 ↓'],['active','最后活跃 ↓'],['orders','订单数 ↓']].map(([k,v])=>option(k,v,sort)).join('')}</select></label>`:`<label>币种<select name="currency">${option('','全部币种',orderCurrency)}${currencies().map(c=>option(c,c,orderCurrency)).join('')}</select></label><label>日期口径<select name="dateField">${option('purchasedAt','购买时间',dateField)}${option('refundedAt','退款时间',dateField)}</select></label>`}<label>${users?'注册':'起始'}日期<input name="start" type="date" value="${listStart}"></label><label>截至日期<input name="end" type="date" value="${listEnd}"></label><button type="submit" class="primary">查询</button>${btn('重置','reset')}</form>`;
}
function pagination(p) {
  return `<footer class="insight-pagination"><span>共 ${p.total} 条 · 每页 10 条</span><div>${btn('上一页','prev',p.page===1?'disabled':'')}<span>${p.page} / ${p.pages}</span>${btn('下一页','next',p.page===p.pages?'disabled':'')}</div></footer>`;
}
function usersView() {
  const filtered=filterUsers(data.users,{query,status,start:listStart,end:listEnd,sort}), p=pageRows(filtered,page); page=p.page;
  const row=u=>`<tr><td>${btn(esc(u.id),'user',`data-id="${esc(u.id)}" class="text-button"`)}<small class="device-id">Device ID: ${esc(u.deviceId||'未记录')}</small></td><td><span class="status-badge">${u.paidOrders?'有净实付':'无净实付'}</span></td><td>${esc(u.country||u.countryCode||'未知')}</td><td>${time(u.createdAt)}</td><td>${time(u.lastSeenAt)}</td><td>${u.paidOrders}</td></tr>`;
  const boards=`<div class="user-board">${[false,true].map(paid=>`<section><h3>${paid?'有净实付订单':'无净实付订单'} <span>${filtered.filter(u=>!!u.paidOrders===paid).length}</span></h3>${p.rows.filter(u=>!!u.paidOrders===paid).map(u=>`<button class="user-card" data-action="user" data-id="${esc(u.id)}"><b>${esc(u.id)}</b><span>${esc(u.country||u.countryCode||'地区未知')} · ${u.paidOrders} 笔净实付订单</span><small>注册 ${dateOf(u.createdAt)}</small></button>`).join('')||'<p>本页无此类用户</p>'}</section>`).join('')}</div>`;
  return `${filters()}<section class="insight-surface"><header><div><h2>用户明细</h2><p>全部身份；日期只筛选注册时间。状态为订单口径，并非当前会员资格。</p></div><div class="view-switch">${btn('表格','user-table',`aria-pressed="${userMode==='table'}"`)}${btn('按付费状态','user-board',`aria-pressed="${userMode==='board'}"`)}</div></header>${userMode==='board'?boards:table(['用户身份','付费状态','地区','注册时间 UTC','最后活跃 UTC','净实付订单'],p.rows.map(row))}${pagination(p)}</section>`;
}
function ordersView() {
  const filtered=filterOrders(data.orders,{query,status,currency:orderCurrency,start:listStart,end:listEnd,dateField,accountId:exactAccount,sku:exactSku}),p=pageRows(filtered,page);page=p.page;
  return `${subscriptionPanelHTML(data.subscriptions)}${filters()}${exactAccount||exactSku?`<p class="scope-note">精确限定：${esc(exactAccount||exactSku)} · 点击“重置”解除</p>`:''}<section class="insight-surface"><header><div><h2>订单与退款</h2><p>金额来自苹果验证记录；点击交易查看退款及归因详情。下方筛选仅用于交易明细。</p></div><span>筛选结果 ${filtered.length} 笔</span></header>${table(['交易','用户','商品','扣款金额','状态','购买时间 UTC'],p.rows.map(o=>`<tr><td>${btn(esc(o.transactionId),'order',`class="text-button" data-id="${esc(o.transactionId)}"`)}</td><td>${esc(o.accountId||'未绑定')}</td><td>${esc(o.sku)}</td><td>${o.priceMilliunits===null||!o.currency?'金额未知':money(o.priceMilliunits,o.currency)}</td><td><span class="status-badge ${o.refunded?'refund':''}">${o.refunded?(o.refundedMilliunits<o.priceMilliunits?'部分退款':'已退款'):o.revocationType==='FAMILY_REVOKE'?'共享已撤销':'未记录退款'}</span>${needsReview(o)?'<span class="status-badge review">归因待核对</span>':''}</td><td>${time(o.purchasedAt)}</td></tr>`))}${pagination(p)}</section>`;
}
function pricesView() {
  return `${paywallHTML(data.paywallPolicy)}<section class="insight-surface"><header><h2>商品价格分布</h2><span>全部已观察订单</span></header><p class="scope-note">这里展示历史已验证订单的价格，不代表当前 App Store 售价；不同币种分别统计。</p>${table(['商品','币种','最低价','最高价','订单数'],data.observedPrices.map(p=>`<tr><td>${esc(p.sku)}</td><td>${esc(p.currency)}</td><td>${money(p.minimumMilliunits,p.currency)}</td><td>${money(p.maximumMilliunits,p.currency)}</td><td>${btn(`${p.count} 笔 →`,'sku',`class="text-button" data-sku="${esc(p.sku)}" data-currency="${esc(p.currency)}"`)}</td></tr>`))}</section>${data.subscriptionCatalog?`<section class="insight-surface"><header><h2>当前售价核对</h2></header><p class="scope-note">${esc($('productSubscriptionCatalog').textContent)}</p></section>`:''}`;
}
function render() {
  document.querySelectorAll('.product-nav a').forEach(link=>{if(link.getAttribute('href')==='#'+viewPanels[view])link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  host.hidden=document.documentElement.dataset.adminStyle!=='pearl';
  if(!snapshot || snapshot.product!==picker.value || loading) {host.innerHTML='<div class="insight-empty" role="status">正在读取当前产品数据…</div>';return;}
  if(snapshot.status==='error') {host.innerHTML=`<div class="insight-empty" role="alert">读取失败：${esc(snapshot.message)}。可点击页面右上角“刷新”重试。</div>`;return;}
  if(!data) return;
  const p=period(data.daily,start,end);
  host.innerHTML=`<div class="workspace-heading"><div><p>${esc(picker.selectedOptions[0].textContent)} / ${titles[view]}</p><h2>${titles[view]}</h2></div><span class="scope-chip">${data.connected?'已接入':'接入未完成'}</span></div><p class="insight-source">${esc($('productNotice').textContent)} · ${view==='marketing'?'按首次获客批次追踪收入':view==='orders'&&data.subscriptions?'订阅日期覆盖全部已接入历史':`趋势仅提供最近 ${data.daily.length} 天`}${document.body.dataset.demo?' · 当前为演示数据':''}</p>${['overview','trends'].includes(view)?periodControl():''}${view==='overview'?overview(p):view==='trends'?trends(p):view==='users'?usersView():view==='orders'?ordersView():view==='marketing'?marketingHTML({...data.marketing,subscriptions:data.subscriptions}):pricesView()}`;
  revealWorkspace();
  if(selectedDay)selectDay(selectedDay);
}
function receive(next) {
  if(next.product!==picker.value) return;
  if(lastProduct===next.product&&data&&(marketingEditing(next.product)||paywallEditing()))return;
  snapshot=next; loading=next.status==='loading';
  if(lastProduct!==next.product) {data=null;view=lastProduct?'overview':initialView;lastProduct=next.product;exactAccount='';exactSku='';query='';status='all';page=1;listStart='';listEnd='';orderCurrency='';selectedDay='';start='';end='';liveToday=false;receivedAt=null;}
  if(next.status==='ready') {
    data=next.data;receivedAt=Date.now();
    const latest=data.daily.at(-1)?.date;
    if(liveToday) {start=latest;end=latest;}
    if(!start || end>latest || start<data.daily[0]?.date) {end=latest;start=shiftDay(end,-6);}
    if(!currencies().includes(currency)) currency=currencies()[0]||'';
  }
  $('productPaywallPolicy').innerHTML=next.status==='ready'?paywallHTML(data.paywallPolicy):'';
  $('productPaywallPolicy').hidden=next.product!=='cleaner';
  $('productMarketing').innerHTML=next.status==='ready'?marketingHTML({...data.marketing,subscriptions:data.subscriptions}):'<p>当前产品投放数据尚未就绪</p>';
  render();
}
function showDetail(kind,id) {
  let title, values;
  if(kind==='user') {
    const u=data.users.find(u=>u.id===id);if(!u)return;
    title='用户详情';values=[['用户 ID',u.id],['设备 ID（产品内安装标识）',u.deviceId||'未记录'],['有过清理',u.hasCompletedCleanup===true?'是':u.hasCompletedCleanup===false?'尚无成功记录':'旧版本未采集'],['注册时间 UTC',time(u.createdAt)],['最后活跃 UTC',time(u.lastSeenAt)],['记录中的活跃天数',u.activeDays],['国家 / 地区',u.country||u.countryCode||'未知'],['最近 IP',u.lastIPAddress||'未记录'],['网络',u.networkOrganization||'未知'],['净实付订单数',u.paidOrders],['邀请码',u.bindingCode||'无']];
  } else {
    const o=data.orders.find(o=>o.transactionId===id);if(!o)return;
    title='交易详情';values=[['交易 ID',o.transactionId],['原始交易 ID',o.originalTransactionId],['用户身份',o.accountId||'未绑定'],['商品',o.sku],['币种',o.currency||'未知'],['扣款（原币）',o.priceMilliunits===null?'未知':amount(o.priceMilliunits)],['退款（原币）',amount(o.refundedMilliunits)],['购买时间 UTC',time(o.purchasedAt)],['退款时间 UTC',o.refundedAt?time(o.refundedAt):o.refunded?'时间未记录':'无退款'],['扣款归因状态',o.singularPurchaseStatus||'未记录'],['退款归因状态',o.singularRefundStatus||'未记录']];
  }
  dialog.innerHTML=`<header><h2 id="insightDetailTitle">${title}</h2><form method="dialog"><button aria-label="关闭详情">关闭 ✕</button></form></header><dl>${values.map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${kind==='user'?btn('查看此用户全部订单','user-orders',`data-id="${esc(id)}" class="primary"`):''}<p class="scope-note">只读信息 · 不修改用户或订单</p>`;
  dialog.setAttribute('aria-labelledby','insightDetailTitle');dialog.showModal();
}
function selectDay(date) {
  const row = data.daily.find(r=>r.date===date);
  if (!row) return;
  selectedDay=date;
  host.querySelectorAll('[data-action="day"]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.date===date)));
  const cursor=host.querySelector('.chart-cursor');
  const point=host.querySelector(`.chart-point[data-date="${date}"]`);
  if(cursor&&point){cursor.removeAttribute('hidden');cursor.setAttribute('x1',point.dataset.x);cursor.setAttribute('x2',point.dataset.x);}
  const detail=host.querySelector('.day-detail');
  detail.innerHTML=`${row.date}：注册 ${row.registrations} · 活跃 ${row.activeUsers} · 实付订单 ${row.paidOrders} · 退款 ${row.refunds} ${btn('查看当天订单','day-orders')}`;
  if(!reducedMotion.matches)detail.animate([{opacity:.25},{opacity:1}],{duration:160});
}
function action(event) {
  const b=event.target.closest('[data-action]');if(!b || !data)return;
  const a=b.dataset.action;
  if(a==='subscription-status'){setView('orders');return;}
  if(a==='today') {liveToday=true;start=end=data.daily.at(-1).date;selectedDay='';render();$('refresh').click();return;}
  if(a==='range') {liveToday=false;end=data.daily.at(-1).date;start=shiftDay(end,1-Number(b.dataset.days));selectedDay='';}
  if(a==='day'){selectDay(b.dataset.date);return;}
  if(a==='metric') {
    const key=b.dataset.key;
    if(key==='activeUsers'){metric='activeUsers';setView('trends');return;}
    setView(key==='registrations'?'users':'orders');listStart=start;listEnd=end;
    status=key==='refunds'?'refund':key==='paidOrders'?'charged':'all';dateField=key==='refunds'?'refundedAt':'purchasedAt';
  }
  if(a==='review'||a==='refund'){setView('orders');status=a==='review'?'review':'refund';}
  if(a==='day-orders'){const day=selectedDay;setView('orders');listStart=day;listEnd=day;if(metric==='refunds'){status='refund';dateField='refundedAt';}if(metric==='gross'){orderCurrency=currency;status='charged';}}
  if(a==='currency'){setView('orders');orderCurrency=b.dataset.currency;listStart=start;listEnd=end;status='charged';}
  if(a==='sku'){setView('orders');exactSku=b.dataset.sku;orderCurrency=b.dataset.currency;}
  if(a==='reset'){exactAccount='';exactSku='';query='';status='all';listStart='';listEnd='';sort='newest';orderCurrency='';dateField='purchasedAt';page=1;}
  if(a==='prev')page--; if(a==='next')page++;
  if(a==='user-table')userMode='table';if(a==='user-board')userMode='board';
  if(a==='user'||a==='order'){showDetail(a,b.dataset.id);return;}
  if(a==='user-orders'){dialog.close();setView('orders');exactAccount=b.dataset.id;}
  render();
}
host.addEventListener('click',action);dialog.addEventListener('click',action);
host.addEventListener('keydown',event=>{
  if(event.target.matches('.chart-point') && ['Enter',' '].includes(event.key)){
    event.preventDefault();selectDay(event.target.dataset.date);
  }
});
host.addEventListener('submit',event=>{
  if(event.target.id.startsWith('marketing'))return;
  event.preventDefault();const f=new FormData(event.target);
  const a=String(f.get('start')||''),b=String(f.get('end')||'');
  if(a&&b&&a>b){event.target.elements.end.setCustomValidity('结束日期不能早于开始日期');event.target.elements.end.reportValidity();return;}
  if(event.target.id==='insightPeriod'){liveToday=false;start=a;end=b;selectedDay='';}
  else {query=String(f.get('query')||'');status=String(f.get('status')||'all');sort=String(f.get('sort')||'newest');listStart=a;listEnd=b;orderCurrency=String(f.get('currency')||'');dateField=String(f.get('dateField')||'purchasedAt');page=1;}
  render();
});
host.addEventListener('input',event=>{if(['start','end'].includes(event.target.name))event.target.form.elements.end.setCustomValidity('');});
host.addEventListener('change',event=>{if(event.target.id==='trendMetric'){metric=event.target.value;render();}if(event.target.id==='trendCurrency'){currency=event.target.value;render();}});
window.addEventListener('admin-product-data',event=>receive(event.detail));
window.addEventListener('admin-insight-view',event=>{if(data)setView(event.detail);});
window.addEventListener('admin-style-change',render);
window.addEventListener('hashchange',()=>setView(viewFromHash()));
window.addEventListener('admin-marketing-change',()=>{if(data&&snapshot?.status==='ready'&&snapshot.product===picker.value){$('productMarketing').innerHTML=marketingHTML({...data.marketing,subscriptions:data.subscriptions});render();}});
picker.addEventListener('change',()=>{if(dialog.open)dialog.close();});
if(window.adminProductSnapshot)receive(window.adminProductSnapshot); else render();

window.addEventListener('admin-paywall-change',()=>{if(data&&picker.value==='cleaner'){$('productPaywallPolicy').innerHTML=paywallHTML(data.paywallPolicy);render();}});
