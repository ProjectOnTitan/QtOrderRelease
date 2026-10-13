// 由 QtOrder 的 CI 與發布 workflow 呼叫，讀取或修改發布紀錄（data/releases.json）。發布規則一律在這裡與 release-model.js，
// QtOrder 不另寫一份（QtOrder ADR-0043）。會寫入的指令寫入前都跑完整驗證，不通過就不寫檔、以非零結束。
// 每個版本只含發布時勾選的券商（ADR-0005），--brokers 以逗號分隔，例如 taishin,capital。
//
//   node scripts/release-record.js baselines --version <v>
//        QtOrder 打包前判斷各家有沒有異動，輸出 JSON：{ versionPublished, brokers: { <券商>: { version, sourceCommit } | null } }
//   node scripts/release-record.js plan --action publish --version <v> --channel preview|stable --source-commit <sha> --brokers <券商>
//        建置發布前檢查，輸出 JSON：{ action, version, channel, brokers, previous: { <券商>: { version, sourceCommit } | null } }
//   node scripts/release-record.js plan --action promote --version <v>
//        晉升前檢查，輸出 JSON：{ action, version, brokers }
//   node scripts/release-record.js publish --version <v> --channel preview|stable --source-commit <sha> --brokers <券商>
//        --notes <版本說明.md> --assets <assets.json> --base-url <下載網址前綴> [--at <時間>]
//   node scripts/release-record.js promote --version <v> [--at <時間>]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BROKERS, brokersOf, checkReleaseRules, compareVersions, includesBroker, isVersion, isWithdrawn, latestStable,
} from '../assets/js/release-model.js';
import { validateReleaseData } from './validate.js';

const NOTE_HEADINGS = {
  升級須知: 'upgradeNotes',
  新功能: 'features',
  改善: 'improvements',
  修正: 'fixes',
  已知問題: 'knownIssues',
};
const CHANNELS = ['preview', 'stable'];
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export class ReleaseRecordError extends Error {}
const fail = (message) => { throw new ReleaseRecordError(message); };

/* 台北時間的 ISO 8601（+08:00），與發布紀錄既有的時間格式一致。 */
export function taipeiNow(date = new Date()) {
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 19)}+08:00`;
}

/* 版本說明（QtOrder 的 release-notes/<版本>.md）：
 *   ---
 *   summary: 一句話摘要
 *   requiresInstaller: false
 *   ---
 *   ## 升級須知
 *   - 一行一項
 * 標題只能是升級須知、新功能、改善、修正、已知問題；需要重新安裝的版本必須寫升級須知。 */
export function parseReleaseNotes(markdown) {
  const text = markdown.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) fail('版本說明開頭缺少 front matter（--- 之間的 summary 與 requiresInstaller）');

  const meta = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const field = /^(\w+):\s*(.*)$/.exec(line);
    if (!field) fail(`front matter 格式不符：${line}`);
    meta[field[1]] = field[2].trim();
  }
  const unknown = Object.keys(meta).filter((key) => !['summary', 'requiresInstaller'].includes(key));
  if (unknown.length) fail(`front matter 有不認得的欄位：${unknown.join('、')}`);
  if (!meta.summary) fail('front matter 缺少 summary');
  if (meta.requiresInstaller !== undefined && !['true', 'false'].includes(meta.requiresInstaller)) {
    fail('requiresInstaller 只能是 true 或 false');
  }

  const notes = {};
  let current = null;
  for (const line of match[2].split('\n')) {
    if (!line.trim()) continue;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = NOTE_HEADINGS[heading[1]];
      if (!current) fail(`不認得的標題「${heading[1]}」，只能用：${Object.keys(NOTE_HEADINGS).join('、')}`);
      if (notes[current]) fail(`標題「${heading[1]}」重複`);
      notes[current] = [];
      continue;
    }
    const item = /^-\s+(.+?)\s*$/.exec(line);
    if (!item || !current) fail(`版本說明只能有標題與「- 」開頭的項目：${line}`);
    notes[current].push(item[1]);
  }
  for (const [key, items] of Object.entries(notes)) if (!items.length) delete notes[key];
  if (!Object.keys(notes).length) fail('版本說明至少要有一個項目');

  const requiresInstaller = meta.requiresInstaller === 'true';
  if (requiresInstaller && !notes.upgradeNotes) fail('需要重新安裝的版本必須在「升級須知」說明客戶要怎麼做');
  return { summary: meta.summary, requiresInstaller, notes };
}

function checkVersion(version) {
  if (!isVersion(version)) fail(`版本號必須是純數字三段：${version}`);
}

/* 檢查發布的參數，回傳依 BROKERS 排序的勾選券商。 */
function checkPublishArgs({ version, channel, sourceCommit, brokers }) {
  checkVersion(version);
  if (!CHANNELS.includes(channel)) fail(`通道只能是 preview 或 stable：${channel}`);
  if (!COMMIT_PATTERN.test(sourceCommit ?? '')) fail(`source commit 必須是 40 碼十六進位：${sourceCommit}`);
  if (!Array.isArray(brokers) || !brokers.length) fail('至少要勾選一家券商');
  const unknown = brokers.filter((broker) => !BROKERS.includes(broker));
  if (unknown.length) fail(`不認得的券商：${unknown.join('、')}（只能是 ${BROKERS.join('、')}）`);
  if (new Set(brokers).size !== brokers.length) fail(`券商重複：${brokers.join(',')}`);
  return BROKERS.filter((broker) => brokers.includes(broker));
}

// 第一個正式版本發布前，發布紀錄是模擬資料；首發時整批清掉（README「發布流程」）。
function startingPoint(data) {
  if (!data.mock) return data;
  // 模擬資料的最低支援版本一併清掉，各家第一個穩定版發布時再設定
  const real = { ...data, mock: false, releases: [] };
  delete real.minimumVersions;
  return real;
}

// 包含這家的最高版本（含已撤回）。QtOrder 以它的 sourceCommit 判斷這家自上次發布以來有沒有異動、
// 是否需要重新安裝（QtOrder ADR-0044）；below 限定只看比它小的版本。
function lastReleaseOf(releases, broker, below) {
  const own = releases.filter((release) => includesBroker(release, broker) && (!below || compareVersions(release.version, below) < 0));
  return own.reduce((best, release) => (!best || compareVersions(release.version, best.version) > 0 ? release : best), null);
}
const baselineOf = (release) => (release ? { version: release.version, sourceCommit: release.sourceCommit ?? null } : null);

/* QtOrder 推到 main 時，決定要打包哪幾家之前呼叫：版本號是否已發布，以及各家的比較基準。 */
export function releaseBaselines(data, { version }) {
  checkVersion(version);
  const base = startingPoint(data);
  return {
    versionPublished: base.releases.some((release) => release.version === version),
    brokers: Object.fromEntries(BROKERS.map((broker) => [broker, baselineOf(lastReleaseOf(base.releases, broker))])),
  };
}

// 寫入前就能判斷的規則：版本號不能重複使用（已發布的版本不補發其他券商），每家的第一個版本只能是穩定版。
function checkPublishable(base, { version, channel, brokers }) {
  if (base.releases.some((release) => release.version === version)) {
    fail(`v${version} 已經發布過：要發布就先升版號，已發布的版本不補發其他券商`);
  }
  if (channel === 'preview') {
    const missing = brokers.filter((broker) => !latestStable(base.releases, broker));
    if (missing.length) fail(`${missing.join('、')} 還沒有穩定版：每家的第一個版本請直接發布為穩定版（首發）`);
  }
}

function placeholderAssets(version, brokers) {
  return brokers.flatMap((broker) => ['installer', 'update'].map((kind) => ({
    broker, kind, name: kind === 'installer' ? `Setup_QtOrder_${broker}_v${version}.exe` : `QtOrder_${broker}_v${version}.zip`,
    size: 1, sha256: '0'.repeat(64), url: 'https://example.invalid/placeholder',
  })));
}

/* 發布或晉升前的檢查（QtOrder ADR-0043）。發布時以假的下載檔案模擬寫入並跑跨欄位規則，
 * 版本號或券商不對就在下載打包結果、建立 GitHub Release 之前失敗。 */
export function planRelease(data, { action, version, channel, sourceCommit, brokers, at = taipeiNow() }) {
  if (action === 'promote') {
    const errors = checkReleaseRules(promoteRelease(data, { version, at }));
    if (errors.length) fail(`晉升 v${version} 會違反發布規則：${errors.join('；')}`);
    return { action, version, brokers: brokersOf(data.releases.find((release) => release.version === version)) };
  }
  if (action !== 'publish') fail(`動作只能是 publish 或 promote：${action}`);

  const selected = checkPublishArgs({ version, channel, sourceCommit, brokers });
  const base = startingPoint(data);
  checkPublishable(base, { version, channel, brokers: selected });
  const simulated = addRelease(base, {
    version, channel, sourceCommit, at, summary: `v${version}`, requiresInstaller: false, notes: {}, assets: placeholderAssets(version, selected),
  });
  const errors = checkReleaseRules(simulated);
  if (errors.length) fail(`這次發布會違反發布規則：${errors.join('；')}`);
  return {
    action,
    version,
    channel,
    brokers: selected,
    previous: Object.fromEntries(selected.map((broker) => [broker, baselineOf(lastReleaseOf(base.releases, broker, version))])),
  };
}

// 發布紀錄的欄位順序固定，寫回檔案時 diff 才好讀。
const RECORD_KEYS = ['$schema', 'schemaVersion', 'mock', 'generatedAt', 'minimumVersions', 'product', 'releases'];
const ordered = (record) => Object.fromEntries(Object.entries(record)
  .sort(([a], [b]) => RECORD_KEYS.indexOf(a) - RECORD_KEYS.indexOf(b)));

function addRelease(base, { version, channel, sourceCommit, at, summary, requiresInstaller, notes, assets }) {
  // 每家的第一個穩定版同時是那家的最低支援版本：最低支援版本必須是包含這家的未撤回穩定版
  const firstStable = channel === 'stable'
    ? [...new Set(assets.map((asset) => asset.broker))].filter((broker) => !latestStable(base.releases, broker))
    : [];
  const release = {
    version,
    channel,
    publishedAt: at,
    sourceCommit,
    ...(requiresInstaller && { requiresInstaller: true }),
    summary,
    releaseUrl: `${base.product.repositoryUrl ?? 'https://github.com/ProjectOnTitan/QtOrderRelease'}/releases/tag/v${version}`,
    notes,
    assets,
  };
  return ordered({
    ...base,
    schemaVersion: 3,
    generatedAt: at,
    ...(firstStable.length && {
      minimumVersions: { ...base.minimumVersions, ...Object.fromEntries(firstStable.map((broker) => [broker, version])) },
    }),
    releases: [release, ...base.releases],
  });
}

/* 新增一個版本，只含勾選的券商。assets.json 由 QtOrder 的 deploy/package-all.ps1 產生：
 * { version, assets: [{ broker, name, kind, size, sha256 }] }，可能含沒勾選的券商，這裡只取勾選的。 */
export function publishRelease(data, { version, channel, sourceCommit, brokers, notesMarkdown, assetsJson, baseUrl, at = taipeiNow() }) {
  const selected = checkPublishArgs({ version, channel, sourceCommit, brokers });
  const base = startingPoint(data);
  checkPublishable(base, { version, channel, brokers: selected });
  if (assetsJson.version !== version) fail(`assets.json 的版本 ${assetsJson.version} 與 ${version} 不符`);
  if (!/^https:\/\//.test(baseUrl ?? '')) fail(`下載網址前綴必須是 https：${baseUrl}`);

  const { summary, requiresInstaller, notes } = parseReleaseNotes(notesMarkdown);
  if (!Array.isArray(assetsJson.assets)) fail('assets.json 缺少 assets');
  const assets = selected.flatMap((broker) => {
    if (!assetsJson.assets.some((asset) => asset.broker === broker)) fail(`assets.json 沒有 ${broker} 的檔案：這次打包沒有包含它`);
    return ['installer', 'update'].map((kind) => {
      const matches = assetsJson.assets.filter((asset) => asset.broker === broker && asset.kind === kind);
      if (matches.length !== 1) fail(`assets.json 的 ${broker}/${kind} 必須恰好一個`);
      const asset = matches[0];
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[0-9a-f]{64}$/.test(asset.sha256)) fail('assets.json 缺少有效大小或雜湊');
      const expectedName = kind === 'installer' ? `Setup_QtOrder_${broker}_v${version}.exe` : `QtOrder_${broker}_v${version}.zip`;
      if (asset.name !== expectedName) fail('下載檔名與券商、版本或檔案種類不符');
      return { name: asset.name, broker, kind, size: asset.size, sha256: asset.sha256, url: `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(asset.name)}` };
    });
  });
  return addRelease(base, { version, channel, sourceCommit, at, summary, requiresInstaller, notes, assets });
}

/* 把預覽版改列為穩定版，整個版本（它包含的所有券商）一起晉升，下載檔案不變（QtOrder ADR-0043）。 */
export function promoteRelease(data, { version, at = taipeiNow() }) {
  checkVersion(version);
  if (data.mock) fail('發布紀錄還是模擬資料：先發布第一個正式版本（首發）');
  const target = data.releases.find((release) => release.version === version);
  if (!target) fail(`發布紀錄裡沒有 v${version}`);
  if (target.channel === 'stable') fail(`v${version} 已經是穩定版`);
  if (isWithdrawn(target)) fail(`v${version} 已撤回，不能晉升`);
  return {
    ...data,
    generatedAt: at,
    releases: data.releases.map((release) => (release === target ? { ...release, channel: 'stable', promotedAt: at } : release)),
  };
}

/* ---------- CLI ---------- */

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) fail(`參數格式不符：${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return options;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dataPath = join(root, 'data/releases.json');
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  const data = readJson(dataPath);
  const common = {
    version: options.version,
    channel: options.channel,
    sourceCommit: options['source-commit'],
    ...(options.brokers !== undefined && { brokers: options.brokers.split(',').map((broker) => broker.trim()).filter(Boolean) }),
    ...(options.at && { at: options.at }),
  };

  let next;
  if (command === 'baselines') {
    console.log(JSON.stringify(releaseBaselines(data, common)));
    return;
  } else if (command === 'plan') {
    console.log(JSON.stringify(planRelease(data, { ...common, action: options.action })));
    return;
  } else if (command === 'publish') {
    next = publishRelease(data, {
      ...common,
      notesMarkdown: readFileSync(options.notes, 'utf8'),
      assetsJson: readJson(options.assets),
      baseUrl: options['base-url'],
    });
  } else if (command === 'promote') {
    next = promoteRelease(data, common);
  } else {
    fail('用法：release-record.js baselines|plan|publish|promote --version <v> …（見檔案開頭說明）');
  }

  const errors = validateReleaseData(next, readJson(join(root, 'data/releases.schema.json')));
  if (errors.length) fail(`發布紀錄驗證失敗：${errors.join('；')}`);
  writeFileSync(dataPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`已更新 data/releases.json：${command} v${options.version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof ReleaseRecordError ? error.message : error);
    process.exit(1);
  }
}
