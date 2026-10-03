/* QtOrder 發布中心
 * 讀取 data/releases.json 後渲染「最新版本」「版本歷程」「安裝與驗證」三區。
 * 版本資料只存在 JSON，由 CI 更新；本檔只負責呈現，不內嵌任何版本。
 * 資料一律以 textContent 寫入 DOM，連結只接受 http(s)，即使 JSON 被竄改也無法注入腳本。 */
(() => {
  'use strict';

  const DATA_URL = 'data/releases.json';
  const PAGE_SIZE = 8;
  const TIME_ZONE = 'Asia/Taipei';
  const THEME_KEY = 'qtorder-theme';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const CHANNELS = {
    stable: { label: '穩定版', icon: 'i-shield-check', hint: '完成完整測試，建議正式交易環境使用。', button: 'primary' },
    preview: { label: '預覽版', icon: 'i-flask', hint: '搶先體驗新功能，可能仍有未修正的問題，請勿用於正式交易。', button: 'neutral' },
  };

  const NOTE_TYPES = [
    { key: 'breaking', label: '重大變更' },
    { key: 'features', label: '新功能' },
    { key: 'improvements', label: '改善' },
    { key: 'fixes', label: '修正' },
    { key: 'knownIssues', label: '已知問題' },
  ];

  // 陣列順序就是同一版本內的顯示順序，第一個是主要下載。
  const ASSET_KINDS = {
    installer: { label: '安裝程式', icon: 'i-download' },
    portable: { label: '免安裝版', icon: 'i-package' },
  };
  const ASSET_ORDER = Object.keys(ASSET_KINDS);
  const FALLBACK_KIND = { label: '檔案', icon: 'i-file' };

  const THEMES = [
    { key: 'system', label: '跟隨系統', icon: 'i-monitor' },
    { key: 'light', label: '淺色', icon: 'i-sun' },
    { key: 'dark', label: '深色', icon: 'i-moon' },
  ];

  const dateFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateTimeFmt = new Intl.DateTimeFormat('zh-TW', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const relativeFmt = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const state = { releases: [], filter: 'all', visible: PAGE_SIZE, open: new Set() };

  const $ = (selector) => document.querySelector(selector);

  /* ---------- DOM 工具 ---------- */

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function icon(id, className = 'icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  function setIcon(container, id) {
    container.querySelector('use')?.setAttribute('href', `#${id}`);
  }

  // 版本說明以反引號標示程式碼，其餘一律當純文字。
  function richText(text) {
    return String(text).split('`').map((part, i) => (i % 2 ? el('code', {}, part) : part)).filter((part) => part !== '');
  }

  function safeUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value, location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function announce(message) {
    const region = $('#announcer');
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = message; });
  }

  /* ---------- 格式化 ---------- */

  const formatDate = (iso) => dateFmt.format(new Date(iso));
  const formatDateTime = (iso) => dateTimeFmt.format(new Date(iso));

  function formatRelative(iso) {
    const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
    if (Math.abs(days) < 30) return relativeFmt.format(days, 'day');
    if (Math.abs(days) < 365) return relativeFmt.format(Math.round(days / 30), 'month');
    return relativeFmt.format(Math.round(days / 365), 'year');
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return null;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  const fileType = (name) => (name.includes('.') ? name.split('.').pop().toUpperCase() : null);
  const releaseId = (release) => `v${release.version}`;

  /* ---------- 資料 ---------- */

  function normalizeReleases(list) {
    if (!Array.isArray(list)) throw new Error('releases 欄位不是陣列');
    return list
      .filter((release) => {
        const valid = release
          && typeof release.version === 'string'
          && Object.hasOwn(CHANNELS, release.channel)
          && !Number.isNaN(Date.parse(release.publishedAt))
          && Array.isArray(release.assets);
        if (!valid) console.warn('略過格式不符的版本資料', release);
        return valid;
      })
      .map((release) => ({ ...release, assets: sortAssets(release.assets) }))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }

  function sortAssets(assets) {
    const rank = (asset) => {
      const index = ASSET_ORDER.indexOf(asset.kind);
      return index === -1 ? ASSET_ORDER.length : index;
    };
    return assets.filter((asset) => asset && typeof asset.name === 'string').sort((a, b) => rank(a) - rank(b));
  }

  const latestOf = (channel) => state.releases.find((release) => release.channel === channel);
  const filtered = () => (state.filter === 'all' ? state.releases : state.releases.filter((r) => r.channel === state.filter));

  /* ---------- 共用元件 ---------- */

  function channelBadge(channel) {
    const meta = CHANNELS[channel];
    return el('span', { class: `badge badge--${channel}` }, icon(meta.icon), meta.label);
  }

  function assetKind(asset) {
    return ASSET_KINDS[asset.kind] ?? FALLBACK_KIND;
  }

  function downloadButton(asset, variant) {
    const href = safeUrl(asset.url);
    if (!href) return null;
    const meta = [fileType(asset.name), formatSize(asset.size)].filter(Boolean).join(' · ');
    return el('a', { class: `btn btn--${variant}`, href },
      icon(variant === 'ghost' ? assetKind(asset).icon : 'i-download'),
      el('span', { class: 'btn__label' }, `下載${asset.label ?? assetKind(asset).label}`),
      meta && el('span', { class: 'btn__meta' }, meta));
  }

  function copyButton(value, what) {
    const button = el('button', { class: 'icon-btn', type: 'button', 'aria-label': `複製${what}`, title: `複製${what}` }, icon('i-copy'));
    bindCopy(button, () => value, what);
    return button;
  }

  // 複製成功時圖示短暫換成勾勾，並透過 live region 告知螢幕報讀器。
  function bindCopy(button, getValue, what) {
    let timer;
    button.addEventListener('click', async () => {
      const ok = await copyText(getValue());
      announce(ok ? `已複製${what}` : '無法自動複製，請手動選取文字');
      if (!ok) return;
      setIcon(button, 'i-check');
      button.classList.add('is-copied');
      clearTimeout(timer);
      timer = setTimeout(() => {
        setIcon(button, 'i-copy');
        button.classList.remove('is-copied');
      }, 2000);
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 非 https 或瀏覽器不支援 Clipboard API 時退回 execCommand，並把焦點還給原按鈕。
      const previous = document.activeElement;
      const area = el('textarea', { class: 'visually-hidden', readonly: true });
      area.value = text;
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      previous?.focus?.();
      return ok;
    }
  }

  function hashRow(asset, variant) {
    if (typeof asset.sha256 !== 'string') return null;
    return el('div', { class: `hash hash--${variant}` },
      el('span', { class: 'hash__label' }, 'SHA-256'),
      el('code', { class: 'hash__value', title: variant === 'compact' ? asset.sha256 : null }, asset.sha256),
      copyButton(asset.sha256, ` ${asset.name} 的 SHA-256`));
  }

  /* ---------- 最新版本 ---------- */

  function renderLatest() {
    const host = $('#latest');
    host.replaceChildren(...Object.keys(CHANNELS).map((channel) => channelCard(channel, latestOf(channel))));
    host.removeAttribute('aria-busy');
  }

  function channelCard(channel, release) {
    const meta = CHANNELS[channel];
    const titleId = `latest-${channel}`;
    const head = el('div', { class: 'channel-card__head' },
      channelBadge(channel),
      el('p', { class: 'channel-card__hint' }, meta.hint));

    if (!release) {
      return el('article', { class: `channel-card channel-card--${channel}`, 'aria-label': `最新${meta.label}` },
        head, el('p', { class: 'empty-state' }, `目前沒有${meta.label}。`));
    }

    const [primary, ...others] = release.assets;
    return el('article', { class: `channel-card channel-card--${channel}`, 'aria-labelledby': titleId },
      head,
      el('div', {},
        el('h2', { class: 'channel-card__version', id: titleId },
          el('span', { class: 'visually-hidden' }, `最新${meta.label} `), `v${release.version}`),
        el('p', { class: 'channel-card__meta' },
          el('time', { datetime: release.publishedAt }, `${formatDate(release.publishedAt)} 發布`),
          el('span', {}, formatRelative(release.publishedAt)))),
      release.summary && el('p', {}, release.summary),
      el('div', { class: 'channel-card__actions' },
        primary && downloadButton(primary, meta.button),
        others.map((asset) => downloadButton(asset, 'ghost'))),
      el('div', { class: 'channel-card__footer' },
        primary && hashRow(primary, 'compact'),
        el('a', { class: 'text-link', href: `#${releaseId(release)}` },
          `查看 v${release.version} 版本說明`, icon('i-arrow-right', 'icon icon--sm icon--move'))));
  }

  /* ---------- 版本歷程 ---------- */

  function renderCounts() {
    const counts = { all: state.releases.length };
    for (const channel of Object.keys(CHANNELS)) counts[channel] = state.releases.filter((r) => r.channel === channel).length;
    for (const node of document.querySelectorAll('[data-count]')) node.textContent = counts[node.dataset.count] ?? '';
  }

  function renderHistory() {
    const list = filtered();
    const shown = list.slice(0, state.visible);
    const host = $('#release-list');
    const label = state.filter === 'all' ? '任何版本' : CHANNELS[state.filter].label;
    host.replaceChildren(...(shown.length ? shown.map(releaseItem) : [el('li', { class: 'empty-state' }, `目前沒有${label}。`)]));
    host.removeAttribute('aria-busy');

    const rest = list.length - shown.length;
    const more = $('#load-more');
    more.hidden = rest <= 0;
    more.querySelector('[data-label]').textContent = `顯示較早的版本（還有 ${rest} 個）`;
  }

  function releaseItem(release) {
    const id = releaseId(release);
    const open = state.open.has(release.version);
    const panel = el('div', { class: 'release__panel', id: `${id}-panel`, hidden: !open }, releaseBody(release));
    const toggle = el('button', {
      class: 'release__toggle', type: 'button', id: `${id}-toggle`, 'aria-expanded': String(open), 'aria-controls': panel.id,
    },
    el('span', { class: 'release__version' }, `v${release.version}`),
    channelBadge(release.channel),
    el('time', { class: 'release__date', datetime: release.publishedAt }, formatDate(release.publishedAt)),
    icon('i-chevron-down', 'icon release__chevron'));

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      panel.hidden = expanded;
      if (expanded) state.open.delete(release.version);
      else state.open.add(release.version);
    });

    return el('li', { class: `release release--${release.channel}`, id },
      el('article', { class: 'release__card', 'aria-labelledby': toggle.id },
        el('h3', { class: 'release__heading' }, toggle),
        release.summary && el('p', { class: 'release__summary' }, release.summary),
        panel));
  }

  function releaseBody(release) {
    const groups = NOTE_TYPES.filter(({ key }) => Array.isArray(release.notes?.[key]) && release.notes[key].length);
    const notes = groups.length
      ? el('div', { class: 'notes' }, groups.map(({ key, label }) => el('section', { class: 'note-group' },
        el('h4', { class: `tag tag--${key}` }, label),
        el('ul', { class: 'note-list' }, release.notes[key].map((item) => el('li', {}, richText(item)))))))
      : el('p', { class: 'section-desc' }, '此版本沒有提供版本說明。');

    const releaseUrl = safeUrl(release.releaseUrl);
    return [
      notes,
      el('div', {},
        el('h4', { class: 'panel-subtitle' }, '下載檔案'),
        el('ul', { class: 'asset-list' }, release.assets.map(assetItem))),
      releaseUrl && el('p', { class: 'release__links' },
        el('a', { class: 'text-link', href: releaseUrl }, '在 GitHub 檢視此版本', icon('i-external', 'icon icon--sm'))),
    ];
  }

  function assetItem(asset) {
    const kind = assetKind(asset);
    const href = safeUrl(asset.url);
    const meta = [asset.label ?? kind.label, asset.platform, formatSize(asset.size)].filter(Boolean).join(' · ');
    return el('li', { class: 'asset' },
      el('span', { class: 'asset__icon' }, icon(kind.icon)),
      el('div', { class: 'asset__body' },
        el('p', { class: 'asset__name' }, asset.name),
        el('p', { class: 'asset__meta' }, meta),
        hashRow(asset, 'full')),
      href && el('a', { class: 'btn btn--ghost asset__download', href },
        icon('i-download'), '下載', el('span', { class: 'visually-hidden' }, ` ${asset.name}`)));
  }

  function setFilter(filter) {
    state.filter = Object.hasOwn(CHANNELS, filter) ? filter : 'all';
    state.visible = PAGE_SIZE;
    for (const button of document.querySelectorAll('[data-filter]')) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    }
    const url = new URL(location.href);
    if (state.filter === 'all') url.searchParams.delete('channel');
    else url.searchParams.set('channel', state.filter);
    history.replaceState(history.state, '', url);

    // 切換篩選後若畫面上沒有展開的版本，展開最新的一筆，讓版本說明一眼可見。
    const shown = filtered().slice(0, state.visible);
    if (shown.length && !shown.some((release) => state.open.has(release.version))) state.open.add(shown[0].version);
  }

  function loadMore() {
    const firstNew = state.visible;
    state.visible += PAGE_SIZE;
    renderHistory();
    // 按鈕可能因為已無更多版本而隱藏，把焦點移到第一個新出現的版本。
    $('#release-list').children[firstNew]?.querySelector('.release__toggle')?.focus();
  }

  // 網址帶 #v1.2.0 時，切到能看見該版本的篩選與分頁、展開並捲動過去。
  function revealFromHash({ focus }) {
    const id = decodeURIComponent(location.hash.slice(1));
    const release = state.releases.find((r) => releaseId(r) === id);
    if (!release) return;

    if (state.filter !== 'all' && release.channel !== state.filter) setFilter('all');
    const index = filtered().indexOf(release);
    if (index >= state.visible) state.visible = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE;
    state.open.add(release.version);
    renderHistory();

    const target = document.getElementById(id);
    target.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    if (focus) target.querySelector('.release__toggle').focus({ preventScroll: true });
  }

  /* ---------- 安裝與驗證、頁首頁尾 ---------- */

  function renderInstall(product) {
    const requirements = Array.isArray(product?.requirements) ? product.requirements : [];
    $('#requirements').replaceChildren(...(requirements.length
      ? requirements.map((item) => el('li', {}, icon('i-circle-check'), el('span', {}, richText(item))))
      : [el('li', {}, '請洽維護人員取得系統需求。')]));

    const sample = (latestOf('stable') ?? state.releases[0])?.assets[0];
    if (sample) $('#hash-command').textContent = `Get-FileHash .\\${sample.name} -Algorithm SHA256`;
  }

  function renderMeta(data) {
    $('#mock-banner').hidden = data.mock !== true;

    if (!Number.isNaN(Date.parse(data.generatedAt))) {
      for (const node of document.querySelectorAll('[data-updated]')) {
        node.replaceChildren(
          node.classList.contains('updated') ? icon('i-clock', 'icon icon--sm') : '',
          el('span', {}, '資料更新：', el('time', { datetime: data.generatedAt }, `${formatDateTime(data.generatedAt)}（台北時間）`)));
        node.hidden = false;
      }
    }

    const repo = safeUrl(data.product?.repositoryUrl);
    if (repo) $('#repo-link').href = repo;
  }

  function renderError(error) {
    console.error('無法載入版本資料', error);
    const retry = el('button', { class: 'btn btn--neutral', type: 'button', onclick: () => load() }, icon('i-refresh'), '重新載入');
    $('#latest').replaceChildren(el('div', { class: 'error-state', role: 'alert' },
      icon('i-alert'),
      el('div', { class: 'error-state__body' },
        el('p', { class: 'error-state__title' }, '無法載入版本資料'),
        el('p', {}, '請確認網路連線後重新載入；若問題持續，請通知維護人員。'),
        retry)));
    $('#latest').removeAttribute('aria-busy');
    $('#release-list').replaceChildren();
    $('#release-list').removeAttribute('aria-busy');
  }

  /* ---------- 主題 ---------- */

  function initTheme() {
    const button = $('#theme-toggle');
    let current = document.documentElement.dataset.theme ?? 'system';

    const apply = (key, { save }) => {
      const theme = THEMES.find((t) => t.key === key) ?? THEMES[0];
      current = theme.key;
      if (theme.key === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme.key;
      setIcon(button, theme.icon);
      const label = `切換主題（目前：${theme.label}）`;
      button.setAttribute('aria-label', label);
      button.title = label;
      if (!save) return;
      try {
        if (theme.key === 'system') localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, theme.key);
      } catch { /* 無痕模式等情況無法保存，僅影響下次造訪 */ }
    };

    apply(current, { save: false });
    button.addEventListener('click', () => {
      const next = THEMES[(THEMES.findIndex((t) => t.key === current) + 1) % THEMES.length];
      apply(next.key, { save: true });
      announce(`主題：${next.label}`);
    });
  }

  /* ---------- 啟動 ---------- */

  async function load() {
    $('#latest').setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.releases = normalizeReleases(data.releases);

      setFilter(new URLSearchParams(location.search).get('channel'));
      renderMeta(data);
      renderLatest();
      renderCounts();
      renderHistory();
      renderInstall(data.product);
      if (location.hash) revealFromHash({ focus: false });
    } catch (error) {
      renderError(error);
    }
  }

  function init() {
    initTheme();

    for (const button of document.querySelectorAll('[data-filter]')) {
      button.addEventListener('click', () => {
        if (button.dataset.filter === state.filter) return;
        setFilter(button.dataset.filter);
        renderHistory();
        announce(`${button.firstChild.textContent.trim()}，共 ${filtered().length} 個版本`);
      });
    }

    $('#load-more').addEventListener('click', loadMore);
    bindCopy($('#copy-command'), () => $('#hash-command').textContent, '指令');

    window.addEventListener('hashchange', () => revealFromHash({ focus: true }));
    // 已在同一個 #v… 時再點一次連結不會觸發 hashchange，這裡補上。
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#v"]');
      if (link && link.getAttribute('href') === location.hash) {
        event.preventDefault();
        revealFromHash({ focus: true });
      }
    });

    load();
  }

  init();
})();
