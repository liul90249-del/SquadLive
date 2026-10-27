const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=v=>{const n=typeof v==='number'?v:Date.parse(v);return Number.isFinite(n)&&n>0?n:null;};
export const latestTimestamp=values=>{const valid=values.map(stamp).filter(v=>v!==null);return valid.length?Math.max(...valid):null;};
const time=v=>stamp(v)?new Date(stamp(v)).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无记录';
export function dataHealth(data,now=Date.now()) {
  const lastSessionAt=latestTimestamp((data.users||[]).map(u=>u.lastSeenAt));
  const lastOrderAt=latestTimestamp((data.orders||[]).map(o=>o.purchasedAt));
  const lastBehaviorAt=latestTimestamp((data.marketing?.users||[]).flatMap(u=>Object.values(u.events||{})));
  const generatedAt=stamp(data.generatedAt);
  return {generatedAt,lastSessionAt,lastOrderAt,lastBehaviorAt,
    stale:generatedAt!==null&&now-generatedAt>120000,
    // A quiet product is not evidence of broken collection.
    noSessions:lastSessionAt===null};
}
export function dataFreshnessHTML(data,receivedAt,now=Date.now()) {
  const h=dataHealth(data,now),cost=data.marketing?.applovin;
  return `<section class="data-freshness" aria-label="数据更新时间"><div><b>${h.stale?'数据快照超过 2 分钟未更新':'真实记录 · 自动刷新'}</b><small>页面读取 ${esc(time(receivedAt))}</small><small>服务端快照 ${esc(time(h.generatedAt))}</small></div><div><span>最近会话发生</span><strong>${esc(time(h.lastSessionAt))}</strong><small>来自 App 已记录会话，安静不等于采集故障</small></div><div><span>最近行为发生</span><strong>${esc(time(h.lastBehaviorAt))}</strong><small>历史未采集的数据不会补造</small></div><div><span>最近正式订单发生</span><strong>${esc(time(h.lastOrderAt))}</strong><small>按苹果已验证记录，排除沙盒</small></div>${cost?`<div><span>广告成本同步</span><strong>${esc(time(cost.lastSuccess))}</strong><small>${esc(cost.start||'—')} 至 ${esc(cost.end||'—')} UTC；${Number.isFinite(cost.rows)?cost.rows:'—'} 条</small></div>`:''}<p>上述时刻均为北京时间；统计日仍为 UTC（北京时间 08:00 换日）。页面刷新成功不代表广告平台或 App 已上报全部数据。</p></section>`;
}
