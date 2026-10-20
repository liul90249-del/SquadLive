const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=v=>v===null || v===undefined?'—':v.toFixed(1)+'%';
const localTime=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未完成';
const count=(row,key,label)=>`<button type="button" class="subscription-count" data-sub-action="people" data-date="${row.date}" data-key="${key}" aria-label="${row.date} ${label} ${row[key].length} 人">${row[key].length}<span> 查看</span></button>`;
const metricInfo = {
  registrations:'所选日期内首次在后台创建的去重安装身份，属于新用户。重新安装可能形成新的安装身份，不代表独立自然人。',
  activeUsers:'所选区间每天活跃安装身份数的平均值，包含新老用户。同一用户每天只计一次；跨天可以重复，不是区间去重总人数。',
  dailyActive:'当天建立过会话的去重安装身份，包含新老用户。当天打开多次只计一人。',
  paidOrders:'苹果验证的实际扣款金额大于 0 的订单笔数，包含新老用户的首购与续费；0 元试用不计入。按扣款日期汇总，后续退款另列。订单笔数不等于付费人数。',
  refunds:'按实际退款日期统计已验证退款订单，包含全额和部分退款，涉及新老用户。退款与关闭续订是两种不同事件。',
  dailyPaying:'该日有订阅或内购实际扣款订单且已绑定后台身份的去重用户，包含首购、续费、新老用户。0 元试用不计入。',
  gross:'苹果验证的实际扣款金额合计，包含首次扣款与续费，未扣除退款；各币种分别显示，不直接相加。',
  day1:'该日注册且有完整会话追踪的用户中，次日再次活跃的人数 ÷ 已到次日观察期的合格新用户。累计口径，不随上方日期筛选。',
  day7:'注册且有完整会话追踪的用户中，第 7 日再次活跃的人数 ÷ 已到第 7 日观察期的合格新用户。累计口径，不随上方日期筛选。',
  date:'日期按 UTC 自然日划分，北京时间每天 08:00 结束上一统计日。进行中的当天数据尚未完整。',
  openedUsers:'当日打开 App 并成功建立会话的去重安装身份，包含新用户和老用户。同一身份一天打开多次只算 1 人，不是打开次数。新注册是当日首次在后台创建的安装身份。当前日活接口保留最近 30 天，历史无记录显示 —。',
  newSubscribers:'当日首次观察到开始订阅的去重用户，包含新用户和老用户；包括 7 天免费试用和直接付费订阅。续费不重复算新订阅。免费试用不代表已经扣钱。',
  cleanupUsers:'该日期新注册的用户中，截至目前有过至少一次成功清理的人数。同一用户清理多次只算 1 人，之后清理会回补到注册日期。包括成功删除照片、视频、日历事件及联系人清理；点击清理但取消或失败不计入。成功记录来自客户端，不上传具体照片或联系人内容。旧版本未采集且无可恢复成功记录时标为未知。',
  firstPayers:'当日首次观察到苹果已验证的订阅扣款金额大于 0 的去重用户，包含新用户和老用户。7 天免费试用的 0 元订单不计入；试用结束真的扣钱后才计入。普通续费不重复计入。后续退款不撤销首次扣款记录，退款另列；历史订单不全时仅代表后台首次观察到。',
  paidConversionRate:'该日期新注册的用户中，截至目前有过实际订阅扣款的人数 ÷ 该日注册人数。包含后续试用转付费，不包含仍在免费试用的人。随后续扣款回补，分母为 0 时显示 —。',
  trialToPaidRate:'该日期首次开始订阅的用户中，截至目前有过实际扣款的人数 ÷ 该日首次订阅人数。包括试用转付费和直接付费，并非只统计试用用户。免费试用尚未扣款不算转付费。',
  cancellations:'在该日期收到苹果关闭自动续订事件的去重用户，包含新老用户、免费试用中和付费中的用户。按苹果通知签发日期记录，一天多次关闭只算 1 人。关闭续订不等于退款，也不代表会员立刻失效；历史漏通知无法恢复精确关闭日期。',
  cohortCancelled:'该日期首次订阅用户中，截至目前曾关闭自动续订的人数，可在以后日期退订；后台持续回补此日期。恢复续订后仍保留曾关闭记录。同一用户只计 1 人，含试用和付费用户。',
  cancellationRate:'该日期首次订阅用户中，截至目前曾关闭自动续订的人数 ÷ 该日首次订阅人数，包含后来恢复续订者。是该批订阅用户的累计退订率，不是当日退订人数 ÷ 当日新订阅人数。续订状态存在未知或分母为 0 时显示 —，历史漏通知仍可能造成缺口。',
  cohortCurrentlyOff:'该日期首次订阅用户中，最近一次已知状态为关闭自动续订的人数。重新开启后从此列移出，但仍计入曾关闭的累计退订人数。以最近核对时间为准。',
  unknownRenewal:'该日期首次订阅用户中，尚未取得有效苹果续订状态的人数。未知不能视为正常续订或未退订。'
};
export const metricLabel=(label,key)=>`<span class="metric-label">${label}<button type="button" class="metric-explain-button" data-sub-action="help" data-metric="${key}" data-label="${esc(label)}" aria-label="${esc(label)}：指标说明" title="${esc(metricInfo[key])}">?</button></span>`;
export const metricHelp=(key,label)=>`<button type="button" class="metric-explain-button" data-sub-action="help" data-metric="${key}" data-label="${esc(label)}" aria-label="${esc(label)}：指标说明" title="${esc(metricInfo[key])}">?</button>`;
let visibleDays=30;
export function subscriptionPanelHTML(report,limit=visibleDays) {
  if(!report) return '';
  const today=report.rows[0],sync=report.sync||{};
  const status={complete:'核对完成',running:'正在核对',partial:'部分失败，自动重试中',failed:'核对失败，自动重试中',unconfigured:'尚未配置苹果订阅状态核对'}[sync.status] || '等待首次核对';
  return `<section class="subscription-panel insight-surface" data-subscription-panel data-limit="${limit}"><header><div><h2>每日订阅与退订</h2><p>UTC 自然日 · 北京时间每天 08:00 核对 · 苹果通知到达后更新</p></div><span class="status-badge">${esc(status)}</span></header>
    <p class="subscription-path-note">按用户路径阅读：打开 App → 开始订阅 / 试用 → 首次实际扣款 → 关闭自动续订。下列卡片统计各环节今日发生人数，并非同一批用户的漏斗。</p><div class="subscription-summary">${today?[['打开 App',today.openedUsers ?? '—',`今日已记录日活 · 新注册 ${today.registrations}`],['开始订阅 / 试用',today.newSubscribers.length,'今日首次订阅，含免费试用'],['首次实际扣款',today.firstPayers.length,'不含免费试用的 0 元订单'],['关闭自动续订',today.cancellations.length,'今日收到关闭续订通知的人数']].map(([title,value,note],index)=>`<div><span class="subscription-step">${String(index+1).padStart(2,'0')} · ${metricLabel(title,['openedUsers','newSubscribers','firstPayers','cancellations'][index])}</span><strong>${value}</strong><small>${note}</small></div>`).join(''):''}</div>
    <p class="scope-note">最近完整核对：${esc(localTime(sync.completedAt))}（北京时间） · ${sync.status==='unconfigured'?'每日核对未启用，需先配置凭据':'下次计划核对：'+esc(localTime(report.nextCheckAt))}${sync.lastError?` · ${esc(sync.lastError)}`:''}<br>状态记录开始：${esc(localTime(report.trackingStartedAt))}。未绑定安装身份的订阅 ${report.unlinked} 个，计入订阅记录，不计入注册转化率。人数按已接入身份去重，不等同于独立自然人。</p>
    <details class="subscription-definitions"><summary>统计口径与数据完整性</summary>${Object.entries(report.definitions).filter(([k])=>k!=='subscriptionRate').map(([k,v])=>`<p><b>${{cleanupUsers:'有过清理的人数',openedUsers:'打开 App',subscriptionRate:'订阅率',paidConversionRate:'付费转化率',cancellationRate:'累计退订率',eventCancellations:'当天退订',trialToPaidRate:'订阅转付费率'}[k]}</b>：${esc(v)}</p>`).join('')}<p>关闭自动续订不等于立即失去会员资格，也不等于退款。历史漏通知无法精确还原退订日期；核对发现已关闭续订时，只回补订阅日的累计退订。续订状态未知时退订率显示“—”；已知状态仍以上次核对为准。</p></details>
    <p class="scope-note">向下查看更早日期，横向滚动查看各项转化率；点击人数查看用户明细。</p><div class="insight-table subscription-table" tabindex="0" role="region" aria-label="每日订阅与退订表格"><table><thead><tr>${[['日期 UTC','date'],['打开 App（日活）','openedUsers'],['有过清理的人数','cleanupUsers'],['开始订阅 / 试用','newSubscribers'],['首次实际扣款','firstPayers'],['注册后付费转化率','paidConversionRate'],['该批订阅转付费率','trialToPaidRate'],['当日关闭续订¹','cancellations'],['该批累计退订²','cohortCancelled'],['该批累计退订率','cancellationRate'],['该批当前关闭续订','cohortCurrentlyOff'],['续订状态未知','unknownRenewal']].map(([label,key])=>`<th>${metricLabel(label,key)}</th>`).join('')}</tr></thead><tbody>${report.rows.slice(0,limit).map(r=>`<tr><td><b>${r.date}</b>${r===today?'<small>进行中</small>':''}</td><td>${r.openedUsers ?? '—'}<small>${r.openedUsers===null?'日活记录不在当前范围':'已记录打开人数'}</small><small>新注册 ${r.registrations}</small></td><td>${count(r,'cleanupUsers','有过清理')}<small>该日新注册用户</small>${r.cleanupUnknownUsers?`<small>另有 ${r.cleanupUnknownUsers} 人未采集</small>`:''}</td><td>${count(r,'newSubscribers','新订阅')}</td><td>${count(r,'firstPayers','首次实际扣款')}</td><td>${pct(r.paidConversionRate)}<small>${r.registeredPaid} / ${r.registrations} 注册</small></td><td>${pct(r.trialToPaidRate)}<small>按该日首次订阅用户</small></td><td>${count(r,'cancellations','关闭续订')}${!report.trackingStartedAt||r.date<new Date(report.trackingStartedAt).toISOString().slice(0,10)?'<small>历史记录可能不完整</small>':''}</td><td>${count(r,'cohortCancelled','累计退订')}</td><td>${pct(r.cancellationRate)}<small>${r.cohortCancelled.length} / ${r.newSubscribers.length} 订阅</small></td><td>${count(r,'cohortCurrentlyOff','当前关闭续订')}</td><td>${r.unknownRenewal}</td></tr>`).join('')}</tbody></table></div>
    <footer class="insight-pagination"><span>从最近日期向下排列 · 已展示 ${Math.min(limit,report.rows.length)} / ${report.rows.length} 天<br>¹ 事件日 · ² 订阅日用户的后续变化</span>${limit<report.rows.length?'<button type="button" data-sub-action="more">加载更早 30 天</button>':'<span>已到最早记录</span>'}</footer></section>`;
}
const classic=document.createElement('div'); classic.id='classicSubscriptions';
document.getElementById('productOrders').closest('.panel').before(classic);
const dialog=document.createElement('dialog');dialog.className='insight-dialog';document.body.append(dialog);
function current(){const snapshot=window.adminProductSnapshot;return snapshot?.product==='cleaner'&&snapshot.status==='ready'?snapshot.data.subscriptions:null;}
function updateClassic(){classic.innerHTML=subscriptionPanelHTML(current());if(window.adminProductSnapshot?.product!=='cleaner'&&dialog.open)dialog.close();}
window.addEventListener('admin-product-data',updateClassic);updateClassic();
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-sub-action]');if(!button)return;
  if(button.dataset.subAction==='close'){dialog.close();return;}
  if(button.dataset.subAction==='help'){const key=button.dataset.metric;if(!metricInfo[key])return;dialog.innerHTML=`<header><h2>${esc(button.dataset.label)}</h2><button type="button" data-sub-action="close">关闭</button></header><p class="metric-explanation">${esc(metricInfo[key])}</p>`;dialog.showModal();return;}
  const report=current();if(!report)return;
  if(button.dataset.subAction==='more'){
    const panel=button.closest('[data-subscription-panel]');visibleDays=Number(panel.dataset.limit)+30;panel.outerHTML=subscriptionPanelHTML(report);return;
  }
  const row=report.rows.find(r=>r.date===button.dataset.date), ids=row?.[button.dataset.key];if(!Array.isArray(ids))return;
  const labels={cleanupUsers:'有过清理的新用户',newSubscribers:'新订阅',cancellations:'关闭续订',firstPayers:'首次实际扣款',cohortCancelled:'该批累计退订',cohortCurrentlyOff:'该批当前关闭续订'};
  dialog.innerHTML=`<header><h2>${row.date} · ${labels[button.dataset.key]}</h2><button type="button" data-sub-action="close">关闭</button></header><p>共 ${ids.length} 个去重身份 · 时间为北京时间</p>${ids.length?`<div class="insight-table"><table><thead><tr><th>用户身份</th><th>首次订阅</th><th>首次实际扣款</th><th>最近已知续订状态</th><th>状态核对时间</th></tr></thead><tbody>${ids.map(id=>{const p=report.people.find(p=>p.id===id);return `<tr><td>${esc(id)}${p?.linked?'':'<small>未绑定安装身份</small>'}</td><td>${p?.subscribedAt?esc(localTime(p.subscribedAt)):'未观察到订阅'}</td><td>${p?.paidAt?esc(localTime(p.paidAt)):'未观察到扣款'}</td><td>${p?.autoRenewStatus===0?'已关闭':p?.autoRenewStatus===1?'已开启':'未知'}</td><td>${p?.checkedAt?esc(localTime(p.checkedAt)):'未核对'}</td></tr>`;}).join('')}</tbody></table></div>`:'<p>暂无已记录用户。</p>'}`;
  dialog.showModal();
});
