import {platformDateFilters} from './marketing-time.mjs';
import {buildMarketingPathsReport,ROUTE_NAMES} from './marketing-paths-report.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>n===null||n===undefined?'—':(n/1000).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const num=n=>n===null||n===undefined?'—':n.toLocaleString('zh-CN');
export function marketingPathsHTML(data,filters){
 if(data.product!=='cleaner')return '';
 filters=platformDateFilters(data,filters);
 const c=data.meta||{},r=buildMarketingPathsReport(data.metaReports,filters);
 const status=!c.configured?'待连接只读报表权限':c.error?'同步失败 · 旧数据保留':!c.lastSuccess?'等待首次同步':!c.enabled?'已连接 · 自动同步未启用':data.now-c.lastSuccess>30*60000?'等待更新 · 数据可能延迟':'自动同步中';
 const time=n=>new Date(n).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 return `<section class="insight-surface market-connection"><header><h2>Facebook · Web / App 投放效果</h2><span class="status-badge">${esc(status)}</span></header>
 <p>广告账号：cleaner-01 · ${esc(c.accountId||'1807440220375930')}。数据来源：Meta Ads Insights；仅同步本产品广告，不创建或修改广告。网页数据集口令不能代替 ads_read 报表权限。</p>
 <p class="scope-note">沿用上方日期与币种选择；本区统计日期 ${esc(filters.start||'全部')} 至 ${esc(filters.end||'全部')}，按 ${esc(c.timezone||'北京时间 UTC+8（账号接口待核验）')} 换日；“今天”和最近天数按本区时区计算。原有 UTC 用户日报单列，日边界不同时不可直接合并。花费按广告实际目的地区分；网页引导下载只计一次花费，不再重复记入 App 直接投放。</p>
 <p>${c.lastSuccess?`最近成功同步：${esc(time(c.lastSuccess))}（北京时间） · ${esc(c.start)} 至 ${esc(c.end)} · ${esc(c.rows)} 条广告日记录`:'尚未完成真实账号同步；缺少记录显示 —，不当作 0 花费。'}${c.currency?` · 账户币种 ${esc(c.currency)}`:''}</p>
 ${c.error?`<p role="alert">${esc(c.error)}</p>`:''}<button data-market="sync-meta" ${!c.configured||data.demo?'disabled':''}>立即同步 Facebook 花费与转化</button><p role="status">${esc(filters.metaSyncMessage||'')}</p>
 <div class="market-table"><table><thead><tr>${['投放路径','广告花费','展示 / 广告点击','网页到达','网页购买 / 平台金额','App 安装','App 购买 / 平台金额'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${r.routes.map(p=>`<tr><td><b>${p.label}</b></td><td>${esc(filters.currency)} ${money(p.spendMilliunits)}</td><td>${num(p.impressions)} / ${num(p.clicks)}</td><td>${num(p.landingPageViews)}</td><td>${num(p.webPurchases)} / ${money(p.webPurchaseMilliunits)}</td><td>${num(p.appInstalls)}</td><td>${num(p.appPurchases)} / ${money(p.appPurchaseMilliunits)}</td></tr>`).join('')}</tbody></table></div>
 <p class="scope-note">上表全部为 Meta 按广告曝光日及广告组归因窗口报告的转化，可能含建模和延迟修订；不是去重后台用户，也不是苹果结算金额。“网页购买”与“App 购买”分别取各自事件，不与 omni_purchase 等汇总事件相加。目的地未知时保留待核对，不按广告名称猜测。</p>
 <details><summary>查看广告系列 / 广告组 / 素材明细（${r.rows.length} 条）</summary><div class="market-table"><table><thead><tr>${['账户统计日 / 路径','广告系列 / 广告组 / 素材','花费','点击 / 到达','网页结账 / 购买','App 安装 / 购买','归因窗口'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${r.rows.slice(0,200).map(v=>`<tr><td>${esc(v.date)}<small>${esc(v.timezone)} · ${esc(ROUTE_NAMES[v.route]||ROUTE_NAMES.unknown)}</small></td><td>${esc(v.campaignName||v.campaignId)}<small>${esc(v.adGroupName||v.adGroupId)} / ${esc(v.adName||v.adId)}</small></td><td>${esc(v.currency)} ${money(v.spendMilliunits)}</td><td>${num(v.clicks)} / ${num(v.landingPageViews)}</td><td>${num(v.webCheckouts)} / ${num(v.webPurchases)}</td><td>${num(v.appInstalls)} / ${num(v.appPurchases)}</td><td>${esc(v.attributionSetting)}</td></tr>`).join('')||'<tr><td colspan="7">当前范围未同步到 Meta 报表记录。</td></tr>'}</tbody></table></div>${r.rows.length>200?'<p>页面展示前 200 条，可缩小日期或来源范围。</p>':''}</details>
 <p class="scope-note">网页实际访问、引导和下载看下方“网页行为”；主动返回 App 的账号及后续苹果验证扣款看“Web → App 来源关联”；App 直接获客与正式订单看现有获客日报。三种证据分开呈现，不能相加当作全量转化。</p></section>`;
}

export function webFunnelHTML(data,s){
 if(data.product!=='cleaner')return '';
 s=platformDateFilters({...data,meta:{timezone:'Asia/Shanghai'}},s);
 const same=c=>(!s.channel||c.utm_source?.toLowerCase()===s.channel.toLowerCase()||['facebook','meta'].includes(s.channel.toLowerCase())&&['fb','facebook','ig','instagram'].includes(c.utm_source?.toLowerCase()))&&(!s.campaignId||c.campaign_id===s.campaignId)&&(!s.adGroupId||c.adset_id===s.adGroupId)&&(!s.creativeId||c.ad_id===s.creativeId);
 const rows=(data.webFunnel?.rows||[]).filter(r=>(!s.start||r.date>=s.start)&&(!s.end||r.date<=s.end)&&same(r.campaign)).sort((a,b)=>b.date.localeCompare(a.date));
 return `<section class="insight-surface"><header><h2>Web 网页行为 · 已同意衡量的实际访问</h2></header><p class="scope-note">本产品引导网页的后台采集，按北京时间（UTC+8）事件发生日及上方渠道、广告层级筛选；“今天”在北京时间 00:00 换日；最多保留 90 天。访问会话、引导完成会话和点击下载会话分别去重，下载点击次数保留重复操作。没有填广告参数的流量标注“来源未标记”，不能直接算广告或自然量。此表不是 Meta 广告归因报表，不计入 App 安装和收入。</p><p>${data.webFunnel?.startedAt?'采集开始：'+esc(new Date(data.webFunnel.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))+'（北京时间）':'新版采集尚未收到首条已授权事件。此前访问和拒绝衡量的访问不能补造。'}</p><div class="market-table"><table><thead><tr>${['北京时间日期 / 网页来源','访问会话 / 页面浏览','完成引导会话','点击下载会话 / 次数'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${rows.slice(0,200).map(r=>`<tr><td>${esc(r.date)}<small>${esc([r.campaign.utm_source||'来源未标记',r.campaign.utm_campaign||r.campaign.campaign_id,r.campaign.adset_name||r.campaign.adset_id,r.campaign.utm_content||r.campaign.ad_id].filter(Boolean).join(' / '))}</small></td><td>${num(r.visits)} / ${num(r.pageViews)}</td><td>${num(r.completions)}</td><td>${num(r.downloadVisits)} / ${num(r.downloadClicks)}</td></tr>`).join('')||'<tr><td colspan="4">当前筛选范围暂无已采集记录；不代表历史访问或花费为 0。</td></tr>'}</tbody></table></div><p class="scope-note">当前网页无网页支付，网页下载不等于安装或付费。Web → App 的主动返回账号与后续已验证扣款单列如下；Meta 的网页购买和 App 购买看上方平台报表。</p></section>`;
}
