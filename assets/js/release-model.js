/* QtOrder 發布規則
 * 發布中心頁面（瀏覽器）與建置腳本（Node）共用本檔，確保頁面顯示的最新版本與
 * 更新清單交給啟動器的版本一致。用語見 CONTEXT.md，版本規則見 docs/adr/0001。 */

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

// 與啟動器的 System.Version 比較方式相同：逐段比數字。
export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export const isWithdrawn = (release) => Boolean(release.withdrawn);

// 版本成為穩定版的時間：晉升的版本取晉升時間，緊急修正取發布時間。
export const stableSince = (release) => release.promotedAt ?? release.publishedAt;

export const BROKERS = ['taishin', 'zf-mega', 'capital'];
export const BROKER_NAMES = { taishin: '台新證券', 'zf-mega': '兆豐證券', capital: '群益證券' };
export const findAsset = (release, kind, broker) => release.assets.find((asset) => asset.kind === kind && asset.broker === broker) ?? null;

/* 每個版本只含發布時勾選的券商（ADR-0005），由下載檔案推導，不另存欄位。
 * 以下的 broker 參數省略時不分券商，供頁面顯示整體歷程。 */
export const brokersOf = (release) => BROKERS.filter((broker) => release.assets.some((asset) => asset.broker === broker));
export const includesBroker = (release, broker) => broker === undefined || release.assets.some((asset) => asset.broker === broker);

function highest(releases) {
  return releases.reduce((best, release) => (!best || compareVersions(release.version, best.version) > 0 ? release : best), null);
}

export function latestStable(releases, broker) {
  return highest(releases.filter((release) => release.channel === 'stable' && !isWithdrawn(release) && includesBroker(release, broker)));
}

// 只有比最新穩定版還新的預覽版才算數；否則預覽版目前沒有可推薦的版本。
export function latestPreview(releases, broker) {
  const stable = latestStable(releases, broker);
  const preview = highest(releases.filter((release) => release.channel === 'preview' && !isWithdrawn(release) && includesBroker(release, broker)));
  if (!preview) return null;
  return !stable || compareVersions(preview.version, stable.version) > 0 ? preview : null;
}

/* 要套用某個版本的更新套件，本機至少要執行過哪個版本的安裝程式（QtOrder ADR-0035）：
 * 版本號不超過它、包含這家、標示需要重新安裝的最高版本。已撤回的也算，之後的版本沿用了它的元件變動。
 * 不含這家的版本不算：QtOrder 發布時逐家比對自己上一版的元件變動，變動會由這家下一個版本自己標示。 */
export function minInstallerVersion(releases, target, broker) {
  const flagged = releases.filter((release) => release.requiresInstaller && includesBroker(release, broker)
    && compareVersions(release.version, target.version) <= 0);
  return highest(flagged)?.version ?? null;
}

/* 更新清單沿用啟動器既有的欄位（stable／preview／min_version），另加更新套件的 SHA-256 與大小，
 * 以及需要重新安裝時的 min_installer_version。各家各自取包含它的最新版本；還沒有穩定版的券商不列入，
 * 啟動器找不到自身券商時不更新、照常啟動本機版本。
 * 預覽版沒有更新的版本時指向穩定版，避免選預覽版的客戶被降級。 */
export function buildUpdateManifest(data) {
  const entry = (release, broker) => {
    const update = findAsset(release, 'update', broker);
    const minInstaller = minInstallerVersion(data.releases, release, broker);
    return {
      broker,
      version: release.version,
      url: update.url,
      sha256: update.sha256,
      size: update.size,
      description: release.summary ?? '',
      ...(minInstaller && { min_installer_version: minInstaller }),
    };
  };
  const brokers = BROKERS.flatMap((broker) => {
    const stable = latestStable(data.releases, broker);
    if (!stable) return [];
    const minimum = data.minimumVersions?.[broker];
    return [[broker, {
      stable: entry(stable, broker),
      preview: entry(latestPreview(data.releases, broker) ?? stable, broker),
      ...(minimum && { min_version: minimum }),
    }]];
  });
  return brokers.length ? { schemaVersion: 2, brokers: Object.fromEntries(brokers) } : null;
}

/* JSON Schema 表達不了的跨欄位規則。回傳錯誤訊息陣列，空陣列代表通過。 */
export function checkReleaseRules(data) {
  const errors = [];
  const releases = data.releases;
  const seen = new Set();

  for (const release of releases) {
    const label = `v${release.version}`;
    if (seen.has(release.version)) errors.push(`${label}：版本號重複`);
    seen.add(release.version);

    if (release.promotedAt && release.channel !== 'stable') errors.push(`${label}：只有穩定版能有晉升時間（promotedAt）`);
    if (release.promotedAt && Date.parse(release.promotedAt) < Date.parse(release.publishedAt)) errors.push(`${label}：晉升時間早於發布時間`);
    if (release.withdrawn && Date.parse(release.withdrawn.at) < Date.parse(release.publishedAt)) errors.push(`${label}：撤回時間早於發布時間`);

    if (release.assets.some((asset) => !BROKERS.includes(asset.broker))) errors.push(`${label}：不認得的券商識別`);
    const included = brokersOf(release);
    if (!included.length) errors.push(`${label}：至少要包含一家券商的下載檔案`);
    for (const broker of included) {
      for (const kind of ['installer', 'update']) {
        const count = release.assets.filter((asset) => asset.kind === kind && asset.broker === broker).length;
        if (count !== 1) errors.push(`${label}：${broker} 必須剛好有一個 ${kind} 下載檔案，目前有 ${count} 個`);
      }
    }
    if (new Set(release.assets.map((asset) => asset.name)).size !== release.assets.length) errors.push(`${label}：下載檔名重複`);
  }

  // 依時間排序後，版本號必須遞增，否則啟動器會被引導降級。
  const increasing = (list, timeOf, what) => {
    const ordered = [...list].sort((a, b) => Date.parse(timeOf(a)) - Date.parse(timeOf(b)));
    for (let i = 1; i < ordered.length; i += 1) {
      if (compareVersions(ordered[i].version, ordered[i - 1].version) <= 0) {
        errors.push(`v${ordered[i].version}：${what}的版本號必須比先前的 v${ordered[i - 1].version} 大`);
      }
    }
  };
  // 版本號三家共用、只從 QtOrder 的 main 發布，所以不分券商都隨發布時間遞增（QtOrder ADR-0043）。
  increasing(releases, (release) => release.publishedAt, '發布');

  const minimums = data.minimumVersions ?? {};
  for (const broker of Object.keys(minimums)) {
    if (!releases.some((release) => includesBroker(release, broker))) errors.push(`${broker}：還沒有任何版本，不能設定最低支援版本`);
  }

  // 晉升不必依版本號順序，但同一家成為穩定版的順序必須遞增；各家的最低支援版本也各自檢查。
  for (const broker of BROKERS) {
    const own = releases.filter((release) => includesBroker(release, broker));
    if (!own.length) continue;
    increasing(own.filter((release) => release.channel === 'stable' && !isWithdrawn(release)), stableSince, `${broker} 穩定版`);
    if (!latestStable(own)) errors.push(`${broker}：至少需要一個未撤回的穩定版，才能產生更新清單`);
    const minimum = own.find((release) => release.version === minimums[broker]);
    if (!minimums[broker]) errors.push(`${broker}：缺少最低支援版本`);
    else if (!minimum || minimum.channel !== 'stable' || isWithdrawn(minimum)) {
      errors.push(`${broker}：最低支援版本 v${minimums[broker]} 必須是一個包含這家的未撤回穩定版`);
    }
  }

  return errors;
}
