// Presentation-only: both styles share admin.html's requests, renderers and data.
(() => {
  const root = document.documentElement;
  const side = document.querySelector('aside');
  const picker = document.getElementById('productPicker');
  if (!side || !picker) return;

  const comparison = document.createElement('div');
  comparison.className = 'appearance-choice';
  comparison.innerHTML = `<span class="appearance-label" id="appearanceLabel">呈现方式</span>
    <div class="appearance-switch" role="group" aria-labelledby="appearanceLabel">
      <button type="button" data-style="classic" aria-pressed="false">A · 经典列表</button>
      <button type="button" data-style="pearl" aria-pressed="false">B · 数据工作台</button>
    </div><p>相同数据，两种工作方式</p>`;
  side.append(comparison);

  function choose(style) {
    const selected = style === 'pearl' ? 'pearl' : 'classic';
    root.dataset.adminStyle = selected;
    comparison.querySelectorAll('button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.style === selected));
    });
    try { localStorage.setItem('squadlive.adminStyle', selected); } catch {}
    // Keep the selected product, section, filters, scroll and loaded data intact.
    const url = new URL(location.href);
    url.searchParams.set('style', selected);
    history.replaceState(null, '', url);
    window.dispatchEvent(new Event('admin-style-change'));
  }
  comparison.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => choose(button.dataset.style));
  });
  choose(root.dataset.adminStyle);

  const sections = [
    ['productCards', '核心数据', '◫'],
    ['productDaily', '每日趋势', '↗'],
    ['productUsers', '用户列表', '◎'],
    ['productOrders', '订阅与订单', '▤'],
    ['productPrices', '商品价格', '◇'],
    ['productMarketing', '广告投放', '◈'],
  ];
  const nav = document.createElement('nav');
  nav.className = 'product-nav';
  nav.setAttribute('aria-label', '产品数据导航');
  for (const [id, label, icon] of sections) {
    const panel = document.getElementById(id).closest('.panel');
    panel.id ||= `${id}Panel`;
    const link = document.createElement('a');
    link.href = `#${panel.id}`;
    link.innerHTML = `<span aria-hidden="true">${icon}</span>${label}`;
    nav.append(link);
  }
  document.getElementById('squadNav').after(nav);
  const productLogos = {
    squadlive: '/assets/landing/squadlive-logo.png',
    cleaner: '/assets/products/cleaner.png',
    dailyme: '/assets/products/dailyme.png',
    nutriscan: '/assets/products/nutriscan.png',
    subguard: '/assets/products/subguard.png',
    sparkle: '/assets/products/sparkle.png',
    catswipe: '/assets/products/catswipe.png',
  };
  const brandLogo = side.querySelector('.brand img');
  const favicon = document.querySelector('link[rel="icon"]');
  const updateNavigation = () => {
    const productName = picker.selectedOptions[0].textContent;
    const logo = productLogos[picker.value];
    brandLogo.src = logo;
    brandLogo.alt = `${productName} 图标`;
    favicon.href = logo;
    document.title = `${productName} · 管理后台`;
    nav.hidden = picker.value === 'squadlive';
    nav.querySelectorAll('a').forEach((link, index) => {
      if (index === 0) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  nav.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    nav.querySelectorAll('a').forEach(item => item.removeAttribute('aria-current'));
    link.setAttribute('aria-current', 'location');
    if (root.dataset.adminStyle === 'pearl') {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('admin-insight-view', {detail: ['overview','trends','users','orders','prices','marketing'][[...nav.children].indexOf(link)]}));
    } else if(picker.value==='cleaner' && link.getAttribute('href')==='#productOrdersPanel' && document.getElementById('classicSubscriptions')?.textContent) {
      event.preventDefault();
      document.getElementById('classicSubscriptions').scrollIntoView({block:'start',behavior:'auto'});
    }
  });
  picker.addEventListener('change', () => {
    updateNavigation();
    const url = new URL(location.href);
    url.searchParams.set('product', picker.value);
    url.hash = '';
    history.replaceState(null, '', url);
  });
  updateNavigation();

  // Keyboard users can reach and scroll the same wide tables in either style.
  const tableIds = ['productDaily', 'productUsers', 'productOrders', 'productPrices',
    'dailyUsageTable', 'recentUsers', 'usersTable', 'rechargesTable', 'vipTable', 'rewardTable'];
  for (const id of tableIds) {
    const target = document.getElementById(id);
    target.classList.add('table-scroll');
    target.tabIndex = 0;
    target.setAttribute('role', 'region');
    target.setAttribute('aria-label', target.closest('.panel')?.querySelector('h2')?.textContent || '数据表格');
  }
})();
