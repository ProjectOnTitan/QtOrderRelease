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

function highest(releases) {
  return releases.reduce((best, release) => (!best || compareVersions(release.version, best.version) > 0 ? release : best), null);
}

export function latestStable(releases) {
  return highest(releases.filter((release) => release.channel === 'stable' && !isWithdrawn(release)));
}

// 只有比最新穩定版還新的預覽版才算數；否則預覽版目前沒有可推薦的版本。
export function latestPreview(releases) {
  const stable = latestStable(releases);
  const preview = highest(releases.filter((release) => release.channel === 'preview' && !isWithdrawn(release)));
  if (!preview) return null;
  return !stable || compareVersions(preview.version, stable.version) > 0 ? preview : null;
}

/* 要套用某個版本的更新套件，本機至少要執行過哪個版本的安裝程式（QtOrder ADR-0035）：
 * 版本號不超過它、標示需要重新安裝的最高版本。已撤回的也算，之後的版本沿用了它的元件變動。 */
export function minInstallerVersion(releases, target) {
  const flagged = releases.filter((release) => release.requiresInstaller && compareVersions(release.version, target.version) <= 0);
  return highest(flagged)?.version ?? null;
}

/* 更新清單沿用啟動器既有的欄位（stable／preview／min_version），另加更新套件的 SHA-256 與大小，
 * 以及需要重新安裝時的 min_installer_version。
 * 預覽版沒有更新的版本時指向穩定版，避免選預覽版的客戶被降級。 */
export function buildUpdateManifest(data) {
  const stable = latestStable(data.releases);
  if (!stable) return null;
  const entry = (release, broker) => {
    const update = findAsset(release, 'update', broker);
    const minInstaller = minInstallerVersion(data.releases, release);
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
  return {
    schemaVersion: 2,
    brokers: Object.fromEntries(BROKERS.map((broker) => [broker, {
      stable: entry(stable, broker),
      preview: entry(latestPreview(data.releases) ?? stable, broker),
      min_version: data.minimumVersion,
    }])),
  };
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

    for (const broker of BROKERS) {
      for (const kind of ['installer', 'update']) {
        const count = release.assets.filter((asset) => asset.kind === kind && asset.broker === broker).length;
        if (count !== 1) errors.push(`${label}：${broker} 必須剛好有一個 ${kind} 下載檔案，目前有 ${count} 個`);
      }
    }
    if (release.assets.some((asset) => !BROKERS.includes(asset.broker))) errors.push(`${label}：不認得的券商識別`);
    if (new Set(release.assets.map((asset) => asset.name)).size !== release.assets.length) errors.push(`${label}：下載檔名重複`);
  }

  // 依成為穩定版／預覽版的時間排序後，版本號必須遞增，否則啟動器會被引導降級。
  const increasing = (list, timeOf, channel) => {
    const ordered = [...list].sort((a, b) => Date.parse(timeOf(a)) - Date.parse(timeOf(b)));
    for (let i = 1; i < ordered.length; i += 1) {
      if (compareVersions(ordered[i].version, ordered[i - 1].version) <= 0) {
        errors.push(`v${ordered[i].version}：${channel}的版本號必須比先前的 v${ordered[i - 1].version} 大`);
      }
    }
  };
  increasing(releases.filter((r) => r.channel === 'stable' && !isWithdrawn(r)), stableSince, '穩定版');
  increasing(releases.filter((r) => r.channel === 'preview' || r.promotedAt), (r) => r.publishedAt, '預覽版');

  // 還沒有任何版本時（第一次發布前）不需要最低支援版本。
  if (!releases.length) return errors;

  if (!latestStable(releases)) errors.push('至少需要一個未撤回的穩定版，才能產生更新清單');

  const minimum = releases.find((release) => release.version === data.minimumVersion);
  if (!minimum || minimum.channel !== 'stable' || isWithdrawn(minimum)) {
    errors.push(`最低支援版本 v${data.minimumVersion} 必須是一個未撤回的穩定版`);
  }

  return errors;
}
