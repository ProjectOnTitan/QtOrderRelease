/* 發布中心
 * 頁面分成 QtOrder 與 QtTrade 兩個產品區塊（ADR-0006），各自讀取自己的發布紀錄後渲染「最新版本」「版本歷程」「安裝與驗證」。
 * QtTrade 首發前（發布紀錄沒有任何版本）它的區塊與產品導覽都不顯示。
 * 每個版本只含發布時勾選的券商（ADR-0005），「最新版本」依所選券商顯示；QtOrder 所選券商記在網址的 ?broker=。
 * 哪個版本算最新、預覽版何時不推薦，一律交給 release-model.js，與更新清單共用同一套規則。
 * 資料一律以 textContent 寫入 DOM，連結只接受 http(s)，即使 JSON 被竄改也無法注入腳本。 */
import {
  BROKER_NAMES, PRODUCTS, assetName, brokersOf, findAsset, includesBroker, isWithdrawn, latestPreview, latestStable, stableSince, tagOf,
} from './release-model.js';

const PAGE_SIZE = 6;
const TIME_ZONE = 'Asia/Taipei';
const SVG_NS = 'http://www.w3.org/2000/svg';

const CHANNELS = {
  stable: { label: '穩定版', icon: 'i-shield-check', hint: '建議正式交易使用，由預覽版驗證後晉升。', button: 'primary' },
  preview: { label: '預覽版', icon: 'i-flask', hint: '搶先試用新功能，請勿用於正式交易。', button: 'secondary' },
};

const NOTE_TYPES = [
  { key: 'upgradeNotes', label: '升級須知' },
  { key: 'features', label: '新功能' },
  { key: 'improvements', label: '改善' },
  { key: 'fixes', label: '修正' },
  { key: 'knownIssues', label: '已知問題' },
];

// 陣列順序就是版本歷程中下載檔案的顯示順序。
const ASSET_KINDS = {
  installer: { label: '安裝程式', icon: 'i-download' },
  update: { label: '更新套件', icon: 'i-package' },
};
const ASSET_ORDER = Object.keys(ASSET_KINDS);
const ASSET_NOTE = '第一次安裝請用安裝程式；更新套件供啟動器自動更新使用，無法單獨安裝。';

const dateFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('zh-TW', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const relativeFmt = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' });
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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
const brokerNames = (brokers) => brokers.map((broker) => BROKER_NAMES[broker]).join('、');

/* ---------- 資料 ---------- */

function normalizeReleases(list) {
  if (!Array.isArray(list)) throw new Error('releases 欄位不是陣列');
  const rank = (asset) => {
    const index = ASSET_ORDER.indexOf(asset.kind);
    return index === -1 ? ASSET_ORDER.length : index;
  };
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
    .map((release) => ({ ...release, assets: release.assets.filter((a) => a && typeof a.name === 'string').sort((a, b) => rank(a) - rank(b)) }))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/* ---------- 共用元件 ---------- */

function channelBadge(channel) {
  const meta = CHANNELS[channel];
  return el('span', { class: `badge badge--${channel}` }, icon(meta.icon), meta.label);
}

const withdrawnBadge = () => el('span', { class: 'badge badge--withdrawn' }, icon('i-alert'), '已撤回');

// 換了券商元件、啟動器或安裝程式的版本，啟動器不會套用更新套件，客戶要重新執行安裝程式（QtOrder ADR-0035）。
const installerBadge = () => el('span', { class: 'badge badge--installer' }, icon('i-download'), '需重新安裝');

const fileMeta = (asset) => [fileType(asset.name), formatSize(asset.size)].filter(Boolean).join(' · ');

// 檔案類型與大小放在按鈕下方的說明文字，以 aria-describedby 連回按鈕。
function downloadButton(asset, variant, describedBy) {
  const href = safeUrl(asset.url);
  if (!href) return null;
  return el('a', { class: `btn btn--${variant} btn--lg`, href, 'aria-describedby': describedBy },
    `下載${BROKER_NAMES[asset.broker]}${ASSET_KINDS[asset.kind]?.label ?? '檔案'}`);
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

// 點選後才顯示的細節用原生 details：展開狀態、鍵盤操作與報讀器朗讀都由瀏覽器處理。
function disclosure(summary, ...content) {
  return el('details', { class: 'disclosure' },
    el('summary', {}, summary, icon('i-chevron-down', 'icon icon--sm')),
    ...content);
}

// 只有要核對檔案的人用得到，預設收合。
function hashRow(asset) {
  if (typeof asset.sha256 !== 'string') return null;
  return disclosure('SHA-256', el('div', { class: 'hash' },
    el('code', { class: 'hash__value' }, asset.sha256),
    copyButton(asset.sha256, ` ${asset.name} 的 SHA-256`)));
}

const releaseBlock = (title, ...children) => el('section', { class: 'release__block' },
  el('h4', { class: 'panel-subtitle' }, title), ...children);

// 內容超過高度上限時才顯示底部的漸層提示；收合中的版本展開後尺寸改變，也會重新判斷
const scrollObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) target.classList.toggle('is-scrollable', target.scrollHeight > target.clientHeight + 1);
});

/* ---------- 產品區塊 ---------- */

/* 一個產品區塊的狀態與渲染。區塊內的元素以 data-* 標記，由 root 往下找，兩個產品的區塊才不會互相干擾；
 * 動態產生的 id 以產品識別開頭（QtOrder 沿用舊的 id 與網址參數，既有的連結不變）。 */
function createProductView(product, root) {
  const prefix = product.id === 'qtorder' ? '' : `${product.id}-`;
  const param = (name) => `${prefix}${name}`;
  const q = (selector) => root.querySelector(selector);
  const qa = (selector) => root.querySelectorAll(selector);
  const multiBroker = product.brokers.length > 1;
  const state = {
    releases: [], minimums: {}, broker: product.brokers[0], filter: 'all', visible: PAGE_SIZE, open: new Set(), downloads: new Set(),
  };

  // 版本的錨點就是它的 tag：QtOrder 是 #v1.6.1，QtTrade 是 #qttrade-v1.0.0
  const releaseId = (release) => tagOf(product, release.version);
  const latestOf = (channel) => (channel === 'stable' ? latestStable(state.releases, state.broker) : latestPreview(state.releases, state.broker));
  const filtered = () => (state.filter === 'all' ? state.releases : state.releases.filter((r) => r.channel === state.filter));
  const installerNotice = () => `此版本需要重新執行安裝程式：已安裝的 ${product.name} 不會自動更新到這一版。`;

  /* ----- 最新版本 ----- */

  function renderLatest() {
    const host = q('[data-latest]');
    host.replaceChildren(...Object.keys(CHANNELS).map((channel) => channelCard(channel, latestOf(channel))));
    host.removeAttribute('aria-busy');
  }

  function emptyCardText(channel) {
    const name = BROKER_NAMES[state.broker];
    const stable = latestStable(state.releases, state.broker);
    if (!state.releases.some((release) => includesBroker(release, state.broker))) return `${name}還沒有發布任何版本。`;
    if (channel === 'preview' && stable) return `${name}目前沒有比穩定版 v${stable.version} 更新的預覽版，請使用穩定版。`;
    return `${name}目前沒有${CHANNELS[channel].label}。`;
  }

  // 卡片上半部回答「選哪個通道、按哪裡下載」，下半部才是這個版本的細節。
  function channelCard(channel, release) {
    const meta = CHANNELS[channel];
    const heading = `${BROKER_NAMES[state.broker]}最新${meta.label}`;
    const titleId = `${prefix}latest-${channel}`;
    const glyph = el('span', { class: 'channel-card__glyph' }, icon(meta.icon));
    const label = el('p', { class: 'channel-card__label' }, meta.label);
    const hint = el('p', { class: 'channel-card__hint' }, meta.hint);

    if (!release) {
      return el('article', { class: `channel-card channel-card--${channel}`, 'aria-label': heading },
        el('div', { class: 'channel-card__main' }, glyph, label, hint, el('p', { class: 'empty-state' }, emptyCardText(channel))));
    }

    // 穩定版的日期是成為穩定版的那天，預覽版則是發布當天。
    const since = channel === 'stable' ? stableSince(release) : release.publishedAt;
    const sinceLabel = channel === 'stable' && release.promotedAt ? '晉升為穩定版' : '發布';
    const installer = findAsset(release, 'installer', state.broker);
    const fileId = `${titleId}-file`;

    return el('article', { class: `channel-card channel-card--${channel}`, 'aria-labelledby': titleId },
      el('div', { class: 'channel-card__main' },
        glyph,
        label,
        el('h2', { class: 'channel-card__version', id: titleId },
          el('span', { class: 'visually-hidden' }, `${heading} `), `v${release.version}`),
        hint,
        installer && el('div', { class: 'channel-card__actions' },
          downloadButton(installer, meta.button, fileId),
          el('p', { class: 'channel-card__file', id: fileId }, fileMeta(installer))),
        // 放在下載按鈕旁、分隔線之上，兩張卡片的下半部才維持相同結構、分隔線對齊
        release.requiresInstaller && el('p', { class: 'channel-card__notice' }, icon('i-alert', 'icon icon--sm'), installerNotice())),
      // 摘要只放在版本歷程，這裡用連結帶過去，不重複
      el('div', { class: 'channel-card__details' },
        el('p', { class: 'channel-card__meta' },
          el('time', { datetime: since }, `${formatDate(since)} ${sinceLabel}`),
          el('span', {}, formatRelative(since))),
        el('a', { class: 'text-link', href: `#${releaseId(release)}` },
          `查看 v${release.version} 版本說明`, icon('i-chevron-right', 'icon icon--sm icon--move')),
        installer && hashRow(installer)));
  }

  /* ----- 券商 ----- */

  // 沒有指定券商時，預設第一家已有穩定版的券商。
  const defaultBroker = () => product.brokers.find((broker) => latestStable(state.releases, broker)) ?? product.brokers[0];

  function setBroker(broker, { persist }) {
    state.broker = product.brokers.includes(broker) ? broker : defaultBroker();
    for (const button of qa('[data-broker]')) {
      button.setAttribute('aria-pressed', String(button.dataset.broker === state.broker));
    }
    if (!persist || !multiBroker) return;
    // 寫進網址，券商 IT 轉給客戶的連結就會直接顯示那一家
    const url = new URL(location.href);
    url.searchParams.set(param('broker'), state.broker);
    history.replaceState(history.state, '', url);
  }

  // 「最新版本」、最低支援版本與核對指令都跟著所選券商。
  function renderBroker() {
    renderLatest();

    const minimum = q('[data-minimum]');
    const version = state.minimums[state.broker];
    minimum.hidden = typeof version !== 'string';
    if (!minimum.hidden) {
      minimum.replaceChildren(icon('i-info', 'icon icon--sm'),
        el('span', {}, `${BROKER_NAMES[state.broker]}最低支援版本：v${version}`));
    }

    const release = latestStable(state.releases, state.broker) ?? latestPreview(state.releases, state.broker);
    const installer = release && findAsset(release, 'installer', state.broker);
    q('[data-hash-command]').textContent = `Get-FileHash .\\${installer?.name ?? assetName(product, 'installer', state.broker, '<版本>')} -Algorithm SHA256`;
  }

  // 只有一家券商的產品沒有券商切換
  function initBrokerSwitch() {
    const host = q('[data-broker-switch]');
    if (!host) return;
    host.replaceChildren(...product.brokers.map((broker) => {
      const button = el('button', { class: 'filter__btn', type: 'button', 'data-broker': broker, 'aria-pressed': 'false' }, BROKER_NAMES[broker]);
      button.addEventListener('click', () => {
        if (broker === state.broker) return;
        setBroker(broker, { persist: true });
        q('[data-latest]').setAttribute('data-switched', '');
        renderBroker();
        const stable = latestStable(state.releases, broker);
        announce(`已切換到${BROKER_NAMES[broker]}${stable ? `，最新穩定版 v${stable.version}` : ''}`);
      });
      return button;
    }));
  }

  /* ----- 版本歷程 ----- */

  function renderCounts() {
    const counts = { all: state.releases.length };
    for (const channel of Object.keys(CHANNELS)) counts[channel] = state.releases.filter((r) => r.channel === channel).length;
    for (const node of qa('[data-count]')) node.textContent = counts[node.dataset.count] ?? '';
  }

  function renderHistory() {
    const list = filtered();
    const shown = list.slice(0, state.visible);
    const host = q('[data-release-list]');
    const label = state.filter === 'all' ? '任何版本' : CHANNELS[state.filter].label;
    host.replaceChildren(...(shown.length ? shown.map(releaseItem) : [el('li', { class: 'empty-state' }, `目前沒有${label}。`)]));
    host.removeAttribute('aria-busy');

    const rest = list.length - shown.length;
    // 還有較早的版本時，時間軸延伸到列表底部並淡出，提示可以往下載入
    host.classList.toggle('release-list--more', rest > 0);
    const more = q('[data-load-more]');
    more.hidden = rest <= 0;
    more.querySelector('[data-label]').textContent = `顯示較早的版本（還有 ${rest} 個）`;
  }

  function releaseItem(release) {
    const id = releaseId(release);
    const withdrawn = isWithdrawn(release);
    const open = state.open.has(release.version);
    const panel = el('div', { class: 'release__panel', id: `${id}-panel`, hidden: !open }, releaseBody(release));
    const toggle = el('button', {
      class: 'release__toggle', type: 'button', id: `${id}-toggle`, 'aria-expanded': String(open), 'aria-controls': panel.id,
    },
    el('span', { class: 'release__title' },
      el('span', { class: 'release__version' }, `v${release.version}`),
      channelBadge(release.channel),
      release.requiresInstaller && installerBadge(),
      withdrawn && withdrawnBadge()),
    el('span', { class: 'release__date' },
      el('time', { datetime: release.publishedAt }, formatDate(release.publishedAt)),
      el('span', { class: 'release__brokers' }, brokerNames(brokersOf(release)))),
    el('span', { class: 'release__indicator' }, icon('i-plus')));

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      panel.hidden = expanded;
      if (expanded) state.open.delete(release.version);
      else state.open.add(release.version);
    });

    // 時間軸：寬螢幕在左側顯示發布日期，節點顏色對應通道；兩者都只是視覺輔助，日期與通道已寫在卡片標題列
    return el('li', { class: `release release--${release.channel}${withdrawn ? ' release--withdrawn' : ''}`, id },
      el('p', { class: 'release__when', 'aria-hidden': 'true' },
        el('span', { class: 'release__when-date' }, formatDate(release.publishedAt)),
        el('span', { class: 'release__when-relative' }, formatRelative(release.publishedAt))),
      el('span', { class: 'release__marker', 'aria-hidden': 'true' }),
      el('article', { class: 'release__card', 'aria-labelledby': toggle.id },
        el('h3', { class: 'release__heading' }, toggle),
        release.summary && el('p', { class: 'release__summary' }, release.summary),
        panel));
  }

  // 每家第一個包含它的版本直接發布為穩定版，是那家的首發；其餘直接發布為穩定版的才是緊急修正。
  const firstReleaseFor = (release) => brokersOf(release).filter((broker) => state.releases.every((other) => other === release
    || !includesBroker(other, broker) || Date.parse(other.publishedAt) >= Date.parse(release.publishedAt)));

  function directStableLabel(release) {
    const first = firstReleaseFor(release);
    if (!first.length) return '直接發布為穩定版（緊急修正）';
    const rest = brokersOf(release).filter((broker) => !first.includes(broker));
    return rest.length ? `直接發布為穩定版（${brokerNames(first)}首發，${brokerNames(rest)}緊急修正）` : '首次發布為穩定版';
  }

  // 展開的內容分成三塊：版本資訊、版本說明（有高度上限，超過時捲動）、下載檔案（預設收合）。撤回的版本沒有下載檔案。
  function releaseBody(release) {
    return [
      releaseInfo(release),
      releaseNotes(release),
      !isWithdrawn(release) && releaseDownloads(release),
    ];
  }

  // 這個版本走過哪些通道（預覽版 → 晉升為穩定版，或首發、緊急修正直接發布為穩定版）、包含的券商與更新方式。
  function releaseInfo(release) {
    const rows = [];
    if (release.channel === 'stable' && !release.promotedAt) {
      rows.push(['發布', `${formatDate(release.publishedAt)}　${directStableLabel(release)}`]);
    } else {
      rows.push(['發布', `${formatDate(release.publishedAt)}　發布於預覽版`]);
      if (release.promotedAt) rows.push(['晉升', `${formatDate(release.promotedAt)}　晉升為穩定版`]);
    }
    rows.push(['券商', brokerNames(brokersOf(release))]);
    if (isWithdrawn(release)) {
      rows.push(['撤回', formatDate(release.withdrawn.at)]);
    } else if (release.requiresInstaller) {
      rows.push(['更新方式', '需要重新執行安裝程式，啟動器不會自動更新到這一版']);
    } else {
      rows.push(['更新方式', release.channel === 'preview'
        ? `發布通道設為預覽版的 ${product.name} 會由啟動器自動更新`
        : `已安裝的 ${product.name} 會由啟動器自動更新`]);
    }

    return releaseBlock('版本資訊',
      el('dl', { class: 'release-info' }, rows.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)])),
      isWithdrawn(release) && el('div', { class: 'callout callout--danger' },
        icon('i-alert'),
        el('div', {},
          el('p', { class: 'callout__title' }, '此版本已撤回，不再提供下載'),
          el('p', {}, release.withdrawn.reason))));
  }

  // 版本說明有高度上限，超過時在區塊內捲動；可以聚焦，鍵盤才捲得動沒有連結的文字
  function releaseNotes(release) {
    const groups = NOTE_TYPES.filter(({ key }) => Array.isArray(release.notes?.[key]) && release.notes[key].length);
    if (!groups.length) return releaseBlock('版本說明', el('p', { class: 'section-desc' }, '此版本沒有提供版本說明。'));

    const scroller = el('div', { class: 'release__scroll', tabindex: '0', role: 'region', 'aria-label': `${product.name} v${release.version} 版本說明` },
      el('div', { class: 'notes' }, groups.map(({ key, label }) => el('section', { class: `note-group note-group--${key}` },
        el('h5', { class: 'note-group__title' }, key === 'upgradeNotes' && icon('i-alert', 'icon icon--sm'), label),
        el('ul', { class: 'note-list' }, release.notes[key].map((item) => el('li', {}, richText(item))))))));
    scrollObserver.observe(scroller);
    return releaseBlock('版本說明', scroller);
  }

  // 下載檔案預設收合；展開狀態記在 state，重新渲染（切換篩選、載入更多）後維持
  function releaseDownloads(release) {
    const id = releaseId(release);
    const open = state.downloads.has(release.version);
    const list = el('ul', { class: 'asset-list', role: 'list', id: `${id}-assets`, hidden: !open }, release.assets.map(assetItem));
    const toggle = el('button', {
      class: 'downloads__toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': list.id,
    },
    icon('i-chevron-right', 'icon icon--sm downloads__indicator'),
    el('span', {}, '下載檔案'),
    el('span', { class: 'downloads__count' }, `${release.assets.length} 個檔案`));

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      list.hidden = expanded;
      if (expanded) state.downloads.delete(release.version);
      else state.downloads.add(release.version);
    });

    return el('section', { class: 'release__block release__block--downloads' },
      el('div', { class: 'downloads__head' },
        el('h4', { class: 'panel-subtitle downloads__heading' }, toggle),
        infoTip(`${id}-assets-tip`, '下載檔案的說明', ASSET_NOTE)),
      list);
  }

  function assetItem(asset) {
    const kind = ASSET_KINDS[asset.kind] ?? { label: '檔案', icon: 'i-file' };
    const href = safeUrl(asset.url);
    return el('li', { class: 'asset' },
      el('span', { class: 'asset__icon' }, icon(kind.icon)),
      el('div', { class: 'asset__body' },
        el('p', { class: 'asset__name' }, asset.name),
        el('p', { class: 'asset__meta' }, [BROKER_NAMES[asset.broker], kind.label, formatSize(asset.size)].filter(Boolean).join(' · ')),
        hashRow(asset)),
      href && el('a', { class: 'btn btn--secondary asset__download', href },
        icon('i-download'), '下載', el('span', { class: 'visually-hidden' }, ` ${asset.name}`)));
  }

  function setFilter(filter) {
    state.filter = Object.hasOwn(CHANNELS, filter) ? filter : 'all';
    state.visible = PAGE_SIZE;
    for (const button of qa('[data-filter]')) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    }
    const url = new URL(location.href);
    if (state.filter === 'all') url.searchParams.delete(param('channel'));
    else url.searchParams.set(param('channel'), state.filter);
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
    q('[data-release-list]').children[firstNew]?.querySelector('.release__toggle')?.focus();
  }

  // 網址帶 #v1.7.1（QtTrade 是 #qttrade-v1.0.0）時，切到能看見該版本的篩選與分頁、展開並捲動過去。
  // 不是這個產品的版本時回傳 false。
  function revealFromHash({ focus }) {
    const id = decodeURIComponent(location.hash.slice(1));
    const release = state.releases.find((r) => releaseId(r) === id);
    if (!release) return false;

    if (state.filter !== 'all' && release.channel !== state.filter) setFilter('all');
    const index = filtered().indexOf(release);
    if (index >= state.visible) state.visible = Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE;
    state.open.add(release.version);
    renderHistory();

    const target = document.getElementById(id);
    target.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    if (focus) target.querySelector('.release__toggle').focus({ preventScroll: true });
    return true;
  }

  /* ----- 安裝與驗證 ----- */

  function renderInstall(productData) {
    const requirements = Array.isArray(productData?.requirements) ? productData.requirements : [];
    q('[data-requirements]').replaceChildren(...(requirements.length
      ? requirements.map((item) => el('li', {}, icon('i-circle-check'), el('span', {}, richText(item))))
      : [el('li', {}, '請洽營業員取得系統需求。')]));

    const brokers = Array.isArray(productData?.brokerRequirements) ? productData.brokerRequirements : [];
    q('[data-broker-requirements]').replaceChildren(...brokers.map(({ broker, items }) => el('section', { class: 'broker-req' },
      el('h4', {}, broker),
      el('ul', { class: 'req-list req-list--compact' }, items.map((item) => el('li', {}, icon('i-circle-check', 'icon icon--sm'), el('span', {}, richText(item))))))));

    renderComponents(productData);
  }

  // 必要元件與安裝程式自動安裝的清單一致，以元件 × 券商的表格呈現；用途收在元件名稱旁的說明提示。
  // 官方載點只接受 http(s)，不合格就不顯示連結。
  function renderComponents(productData) {
    const components = Array.isArray(productData?.components) ? productData.components : [];
    const card = q('[data-components-card]');
    if (!card) return;
    card.hidden = components.length === 0;

    // 窄螢幕欄寬不夠，券商欄改顯示簡稱；完整名稱保留給螢幕閱讀器
    q('[data-components-head]').replaceChildren(el('tr', {},
      el('th', { scope: 'col' }, '元件'),
      product.brokers.map((broker) => el('th', { scope: 'col', class: 'component-table__broker' },
        el('span', { class: 'component-table__full' }, BROKER_NAMES[broker]),
        el('span', { class: 'component-table__short', 'aria-hidden': 'true' }, BROKER_NAMES[broker].replace(/(證券|期貨)$/, '')))),
      el('th', { scope: 'col' }, el('span', { class: 'visually-hidden' }, '官方載點'))));

    q('[data-components]').replaceChildren(...components.map(({ name, purpose, brokers, url }, index) => {
      const href = safeUrl(url);
      const needed = Array.isArray(brokers) ? brokers : [];
      return el('tr', {},
        el('th', { scope: 'row', class: 'component-table__name' },
          el('span', {}, name),
          purpose && infoTip(`${prefix}component-tip-${index}`, `${name}的用途`, purpose)),
        product.brokers.map((broker) => el('td', { class: 'component-table__mark' }, needed.includes(broker)
          ? [icon('i-check', 'icon icon--sm'), el('span', { class: 'visually-hidden' }, '需要')]
          : [el('span', { class: 'component-table__none', 'aria-hidden': 'true' }, '—'), el('span', { class: 'visually-hidden' }, '不需要')])),
        el('td', { class: 'component-table__link' }, href && el('a', { class: 'btn btn--secondary btn--sm', href },
          icon('i-download', 'icon icon--sm'),
          el('span', { class: 'component-table__link-text' }, '官方下載'),
          el('span', { class: 'visually-hidden' }, `：${name}`))));
    }));
  }

  /* ----- 載入 ----- */

  function renderError(error) {
    console.error(`無法載入 ${product.name} 的版本資料`, error);
    const retry = el('button', { class: 'btn btn--primary', type: 'button', onclick: () => load() }, icon('i-refresh'), '重新載入');
    q('[data-latest]').replaceChildren(el('div', { class: 'error-state', role: 'alert' },
      icon('i-alert'),
      el('div', { class: 'error-state__body' },
        el('p', { class: 'error-state__title' }, '無法載入版本資料'),
        el('p', {}, '請確認網路連線後重新載入；若問題持續，請通知營業員。'),
        retry)));
    q('[data-latest]').removeAttribute('aria-busy');
    q('[data-release-list]').replaceChildren();
    q('[data-release-list]').removeAttribute('aria-busy');
  }

  /* 讀取發布紀錄並渲染，回傳發布紀錄。optional 的產品（QtTrade）讀不到或還沒有任何版本時不渲染、
   * 也不顯示錯誤，由呼叫端決定要不要顯示這個區塊。 */
  async function load({ optional = false } = {}) {
    q('[data-latest]').setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(product.record, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.releases = normalizeReleases(data.releases);
      state.minimums = data.minimumVersions && typeof data.minimumVersions === 'object' ? data.minimumVersions : {};
      if (optional && !state.releases.length) return null;

      const params = new URLSearchParams(location.search);
      setBroker(params.get(param('broker')), { persist: false });
      setFilter(params.get(param('channel')));
      renderBroker();
      renderCounts();
      renderHistory();
      renderInstall(data.product);
      return data;
    } catch (error) {
      if (optional) {
        console.warn(`無法載入 ${product.name} 的版本資料，不顯示它的區塊`, error);
        return null;
      }
      renderError(error);
      return null;
    }
  }

  function init() {
    initBrokerSwitch();
    for (const button of qa('[data-filter]')) {
      button.addEventListener('click', () => {
        if (button.dataset.filter === state.filter) return;
        setFilter(button.dataset.filter);
        renderHistory();
        announce(`${product.name} ${button.firstChild.textContent.trim()}，共 ${filtered().length} 個版本`);
      });
    }
    q('[data-load-more]').addEventListener('click', loadMore);
    bindCopy(q('[data-copy-command]'), () => q('[data-hash-command]').textContent, '指令');
  }

  init();
  return { product, root, load, revealFromHash };
}

/* ---------- 說明提示 ---------- */

// 「i」按鈕：滑鼠移入或鍵盤聚焦時顯示，點選後固定顯示到再點一次、按 Esc 或點選其他地方。
// 提示以 aria-describedby 連到按鈕，螢幕閱讀器聚焦時就會念出；提示本身可以移入（WCAG 1.4.13）。
const tips = { open: null, pinned: false, hideTimer: 0 };

function infoTip(id, label, text) {
  const bubble = el('span', { class: 'tip__bubble', role: 'tooltip', id, hidden: true }, text);
  const button = el('button', { class: 'tip__button', type: 'button', 'aria-label': label, 'aria-describedby': id }, icon('i-info', 'icon icon--sm'));
  const tip = el('span', { class: 'tip' }, button, bubble);

  tip.addEventListener('mouseenter', () => showTip(tip));
  tip.addEventListener('mouseleave', () => { if (!tips.pinned) scheduleHideTip(); });
  button.addEventListener('focus', () => showTip(tip));
  // 焦點離開就收起；滑鼠還停在上面時留著
  button.addEventListener('blur', () => { if (tips.open === tip && !tip.matches(':hover')) hideTip(); });
  button.addEventListener('click', () => {
    const pinned = tips.open === tip && tips.pinned;
    if (pinned) hideTip();
    else { showTip(tip); tips.pinned = true; }
  });
  return tip;
}

function showTip(tip) {
  clearTimeout(tips.hideTimer);
  if (tips.open && tips.open !== tip) hideTip();
  tips.open = tip;
  const bubble = tip.querySelector('.tip__bubble');
  bubble.hidden = false;
  positionTip(tip);
}

// 移到提示上的途中會短暫離開按鈕，稍等一下再收起
function scheduleHideTip() {
  clearTimeout(tips.hideTimer);
  tips.hideTimer = setTimeout(hideTip, 150);
}

function hideTip() {
  clearTimeout(tips.hideTimer);
  if (tips.open) tips.open.querySelector('.tip__bubble').hidden = true;
  tips.open = null;
  tips.pinned = false;
}

// 提示以 fixed 定位在按鈕上方（上方空間不夠時改到下方），左右不超出視窗，也不被表格的捲動區塊裁掉
function positionTip(tip) {
  const button = tip.querySelector('.tip__button').getBoundingClientRect();
  const bubble = tip.querySelector('.tip__bubble');
  const margin = 12;
  const gap = 8;
  const { width, height } = bubble.getBoundingClientRect();
  const headerBottom = $('.localnav')?.getBoundingClientRect().bottom ?? 0;
  const above = button.top - gap - height >= headerBottom + margin;
  const left = Math.min(Math.max(button.left + button.width / 2 - width / 2, margin), document.documentElement.clientWidth - width - margin);
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(above ? button.top - gap - height : button.bottom + gap)}px`;
}

function initTips() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && tips.open) hideTip();
  });
  document.addEventListener('click', (event) => {
    if (tips.open && !tips.open.contains(event.target)) hideTip();
  });
  // fixed 定位不會跟著頁面捲動，捲動或縮放時重新計算位置
  const reposition = () => { if (tips.open) positionTip(tips.open); };
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition);
}

/* ---------- 頁首頁尾 ---------- */

// 頁尾的「資料更新」取所有顯示中產品最晚的修改時間；任何一個是模擬資料就顯示提示
function renderMeta(records) {
  $('#mock-banner').hidden = !records.some((data) => data.mock === true);

  const times = records.map((data) => data.generatedAt).filter((iso) => !Number.isNaN(Date.parse(iso)));
  if (times.length) {
    const latest = times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
    const node = $('[data-updated]');
    node.replaceChildren('資料更新：', el('time', { datetime: latest }, `${formatDateTime(latest)}（台北時間）`));
    node.hidden = false;
  }

  const repo = safeUrl(records[0]?.product?.repositoryUrl);
  if (repo) $('#repo-link').href = repo;
}

// 窄螢幕時頁首連結收進下拉選單（寬螢幕由 CSS 直接顯示，按鈕隱藏）。
// 點選連結、按 Esc、點選頁首以外或焦點離開頁首時收合，避免選單蓋住其他內容的焦點。
function initLocalNav() {
  const nav = $('.localnav__nav');
  const toggle = $('#localnav-toggle');
  const menu = $('#localnav-menu');
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    menu.classList.toggle('is-open', open);
  };

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });
  nav.addEventListener('focusout', (event) => {
    if (!nav.contains(event.relatedTarget)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    setOpen(false);
    toggle.focus();
  });
  document.addEventListener('click', (event) => {
    if (isOpen() && !nav.contains(event.target)) setOpen(false);
  });
}

/* ---------- 啟動 ---------- */

async function init() {
  initLocalNav();
  initTips();

  const qtorder = createProductView(PRODUCTS.qtorder, $('#qtorder'));
  const qttrade = createProductView(PRODUCTS.qttrade, $('#qttrade'));
  const views = [qtorder, qttrade];
  const reveal = (options) => views.some((view) => !view.root.hidden && view.revealFromHash(options));

  window.addEventListener('hashchange', () => reveal({ focus: true }));
  // 已在同一個版本錨點時再點一次連結不會觸發 hashchange，這裡補上。
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (link && link.getAttribute('href') === location.hash && reveal({ focus: true })) event.preventDefault();
  });

  const [orderData, tradeData] = await Promise.all([qtorder.load(), qttrade.load({ optional: true })]);

  // QtTrade 首發前整個區塊與產品導覽都不顯示（ADR-0006）
  const showTrade = tradeData !== null;
  qttrade.root.hidden = !showTrade;
  for (const node of document.querySelectorAll('[data-show-with="qttrade"]')) node.hidden = !showTrade;

  renderMeta([orderData, tradeData].filter(Boolean));
  if (location.hash && !reveal({ focus: false }) && showTrade && location.hash === '#qttrade') {
    // 區塊原本隱藏，瀏覽器載入時捲不到 #qttrade，顯示後補捲一次（QtTrade 啟動器的「前往下載」連到這裡）
    qttrade.root.scrollIntoView({ block: 'start' });
  }
}

init();
