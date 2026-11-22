const labels = {
  app_update: '更新 App', os_update: '系统更新', ad_reward: '激励广告奖励',
  app_open: '打开游戏', first_open: '首次打开', session_start: '会话开始',
  user_engagement: '使用互动', screen_view: '页面浏览',
  game_start: '开始游戏', game_pause: '暂停游戏', game_end: '结束游戏',
  mode_select: '选择玩法', cat_sounds_open: '打开猫咪声音', sound_play: '播放猫咪声音',
  settings_open: '打开设置', rate_us_tap: '点击评分', restore_purchases_tap: '恢复购买',
  contact_us_tap: '联系客服', terms_tap: '查看条款', privacy_tap: '查看隐私政策',
  language_change: '切换语言', ad_impression: '广告展示', ad_click: '广告点击',
};
const esc = value => String(value ?? '—').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';
const cells = values => `<tr>${values.map(value => `<td>${esc(value)}</td>`).join('')}</tr>`;
const table = (headers, rows, empty = '所选时间内暂无记录') => rows.length
  ? `<div class="table-scroll" tabindex="0"><table><thead><tr>${headers.map(header => `<th scope="col">${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  : `<p class="sub">${esc(empty)}</p>`;

export function renderCatSwipeDetails({ root, report, operations, apiPost, refresh }) {
  root.innerHTML = `
    <nav class="tools" aria-label="CatSwipe 数据导航">
      <a href="#catswipeEventsPanel">事件统计</a><a href="#catswipeUsersPanel">用户列表</a>
      <a href="#catswipeRegionsPanel">地区与设备</a><a href="#catswipeIPPanel">IP 分析</a>
    </nav>
    <div class="panel" id="catswipeEventsPanel"><div class="panel-head"><h2>事件触发统计</h2></div>
      <p class="sub">Firebase Analytics · 跟随上方统计范围；触发用户按事件分别去重。</p>
      ${table(['事件', '事件名', '触发次数', '触发用户'], (report.eventRows || []).map(event =>
        cells([labels[event.name] || event.name, event.name, event.eventCount, event.totalUsers])))}
    </div>
    <div class="panel" id="catswipeUsersPanel"><div class="panel-head"><h2>用户列表</h2></div>
      <p class="sub" id="catswipeIdentityStatus"></p>
      <label>搜索用户、设备、IP 或地区 <input id="catswipeUserSearch" type="search" autocomplete="off"></label>
      <div id="catswipeUserRows"></div>
    </div>
    <div class="panel" id="catswipeRegionsPanel"><div class="panel-head"><h2>地区与设备</h2></div>
      <p class="sub">Firebase Analytics · 地区为估算值，同一玩家可能出现在多个地区或版本中。</p>
      ${table(['国家 / 地区', '城市', '活跃玩家', '新增玩家'], (report.regions || []).map(row =>
        cells([row.country, row.city, row.activeUsers, row.newUsers])))}
      ${table(['平台', '版本', '设备类型', '活跃玩家', '会话数'], (report.versions || []).map(row =>
        cells([row.platform, row.version, row.device, row.activeUsers, row.sessions])))}
    </div>
    <div class="panel" id="catswipeIPPanel"><div class="panel-head"><h2>IP 分析</h2></div>
      <p class="sub">新版本接入后的连接 IP、地区与运营商；同一出口 IP 可能对应多个安装身份。</p>
      <div id="catswipeIPRows"></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>最近上报事件</h2></div>
      <p class="sub">后台记录 · 北京时间 · 最近 200 条 · 跟随统计范围。</p>
      <div id="catswipeRecentEvents"></div>
    </div>`;
  const users = operations?.users || [];
  const status = root.querySelector('#catswipeIdentityStatus');
  status.textContent = operations
    ? `后台已记录 ${users.length} 个安装身份。用户列表从接入上报的新版本开始累计，Firebase 历史汇总保留在上方。`
    : '用户与 IP 数据读取失败，请点击刷新重试。';

  function showUsers() {
    const query = root.querySelector('#catswipeUserSearch').value.trim().toLowerCase();
    const matching = users.filter(user => [user.id, user.deviceId, user.lastIPAddress, user.country,
      user.countryCode, user.networkCity, user.networkOrganization].some(value => String(value || '').toLowerCase().includes(query)));
    root.querySelector('#catswipeUserRows').innerHTML = `<p class="sub">匹配 ${matching.length} 个安装身份${matching.length > 500 ? '，显示前 500 个' : ''} · 时间为北京时间</p>` + table(
      ['安装身份', '首次登记', '最后活跃', '版本 / 设备', 'IP', '地区 / 网络', '详情'],
      matching.slice(0, 500).map(user => `<tr>
        <td>${esc(user.id)}</td><td>${esc(time(user.createdAt))}</td><td>${esc(time(user.lastSeenAt))}</td>
        <td>${esc([user.clientInfo?.appVersion, user.clientInfo?.build, user.clientInfo?.deviceModel].filter(Boolean).join(' / '))}</td>
        <td>${esc(user.lastIPAddress)}</td><td>${esc([user.country, user.networkCity, user.networkOrganization || user.networkISP].filter(Boolean).join(' / '))}</td>
        <td><button data-cat-user="${esc(user.id)}">查看资料</button></td></tr>`),
      '尚无安装身份记录。安装接入上报的新版本并打开游戏后，将显示用户、IP 和事件明细。');
  }
  root.querySelector('#catswipeUserSearch').addEventListener('input', showUsers);
  showUsers();
  const byIP = new Map();
  for (const user of users) {
    if (!user.lastIPAddress) continue;
    const group = byIP.get(user.lastIPAddress) || { count: 0, user };
    group.count += 1;
    byIP.set(user.lastIPAddress, group);
  }
  root.querySelector('#catswipeIPRows').innerHTML = table(
    ['出口 IP', '安装身份数', '国家 / 城市', 'ASN / 网络', '最近活跃'],
    [...byIP].map(([ip, { count, user }]) => cells([ip, count,
      [user.country, user.networkCity].filter(Boolean).join(' / '),
      [user.networkASN, user.networkOrganization || user.networkISP].filter(Boolean).join(' / '), time(user.lastSeenAt)])),
    '新版本尚未上报连接 IP。');
  root.querySelector('#catswipeRecentEvents').innerHTML = table(
    ['时间', '安装身份', '事件', '参数'], (operations?.gameplay?.recent || []).map(event =>
      cells([time(event.occurredAt), event.userId, labels[event.name] || event.name, JSON.stringify(event.parameters)])),
    '新版本尚无逐用户事件记录。');

  root.onclick = async event => {
    const button = event.target.closest('[data-cat-user]');
    if (!button) return;
    const user = users.find(user => user.id === button.dataset.catUser);
    if (!user) return;
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'max-width:900px;width:90vw;max-height:85vh;overflow:auto';
    dialog.innerHTML = `<form method="dialog"><button>关闭</button></form><h2>用户资料</h2>
      ${table(['字段', '值'], [
        ['安装身份', user.id], ['设备 ID', user.deviceId], ['首次登记', time(user.createdAt)],
        ['最后活跃', time(user.lastSeenAt)], ['活跃天数', user.activeDays],
        ['运行环境', user.clientInfo?.environment === 'simulator' ? '模拟器测试' : user.clientInfo?.environment === 'device' ? '设备' : '未记录'],
        ['App 版本', user.clientInfo?.appVersion], ['构建号', user.clientInfo?.build],
        ['设备 / 系统', [user.clientInfo?.deviceModel, user.clientInfo?.osVersion].filter(Boolean).join(' / ')],
        ['语言', user.clientInfo?.language], ['首次 IP', user.firstIPAddress], ['最近 IP', user.lastIPAddress],
        ['国家 / 城市', [user.country, user.networkRegion, user.networkCity].filter(Boolean).join(' / ')],
        ['ASN / 运营商', [user.networkASN, user.networkOrganization, user.networkISP].filter(Boolean).join(' / ')],
        ['同出口 IP 安装数', user.sameIPUserCount], ['IP 解析状态', user.networkLookupStatus],
      ].map(cells))}<h3>IP 历史</h3>
      ${table(['IP', '国家 / 城市', '首次出现', '最后出现'], (user.ipHistory || []).map(row =>
        cells([row.ip, [row.country, row.city].filter(Boolean).join(' / '), time(row.firstSeenAt), time(row.lastSeenAt)])))}
      <button data-network>重新解析 IP</button><p role="status"></p>`;
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.querySelector('[data-network]').insertAdjacentHTML('beforebegin', `<h3>已保存事件次数（最近 90 天）</h3>${table(['事件', '次数'], Object.entries(user.gameplayCounts || {}).map(([name, count]) => cells([labels[name] || name, count])))}`);
    dialog.querySelector('[data-network]').onclick = async networkEvent => {
      const control = networkEvent.target;
      control.disabled = true;
      try {
        await apiPost(`/v1/admin/products/catswipe/users/${encodeURIComponent(user.id)}/network`, {});
        dialog.close();
        await refresh();
      } catch (error) {
        dialog.querySelector('[role=status]').textContent = error.message;
        control.disabled = false;
      }
    };
    document.body.append(dialog);
    dialog.showModal();
  };
}
