// 由 QtOrder 的發布 workflow 呼叫，修改發布紀錄（data/releases.json）。發布規則一律在這裡與 release-model.js，
// QtOrder 不另寫一份（QtOrder ADR-0033）。每個指令寫入前都跑完整驗證，不通過就不寫檔、以非零結束。
//
//   node scripts/release-record.js plan    --version <v> --channel preview|stable --source-commit <sha>
//        判斷這次觸發要做什麼，輸出 JSON：{ action: "publish"|"promote", channel, previousVersion, previousSourceCommit }
//   node scripts/release-record.js publish --version <v> --channel preview|stable --source-commit <sha>
//        --notes <版本說明.md> --assets <assets.json> --base-url <下載網址前綴> [--at <時間>]
//   node scripts/release-record.js promote --version <v> --source-commit <sha> [--at <時間>]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkReleaseRules, compareVersions, isVersion, isWithdrawn, latestStable } from '../assets/js/release-model.js';
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

function checkArgs({ version, channel, sourceCommit }) {
  if (!isVersion(version)) fail(`版本號必須是純數字三段：${version}`);
  if (channel !== undefined && !CHANNELS.includes(channel)) fail(`通道只能是 preview 或 stable：${channel}`);
  if (!COMMIT_PATTERN.test(sourceCommit ?? '')) fail(`source commit 必須是 40 碼十六進位：${sourceCommit}`);
}

// 第一個正式版本發布前，發布紀錄是模擬資料；首發時整批清掉（README「發布流程」）。
function startingPoint(data) {
  if (!data.mock) return data;
  // 模擬資料的最低支援版本一併清掉，首發時改設為首發版本
  const real = { ...data, mock: false, releases: [] };
  delete real.minimumVersion;
  return real;
}

// 版本號比新版本小的最高版本（含已撤回），是判斷「需要重新安裝」時 git diff 的比對基準。
function previousOf(releases, version) {
  const lower = releases.filter((release) => compareVersions(release.version, version) < 0);
  return lower.reduce((best, release) => (!best || compareVersions(release.version, best.version) > 0 ? release : best), null);
}

function placeholderAssets(version) {
  const asset = (kind, name) => ({ name, kind, size: 1, sha256: '0'.repeat(64), url: `https://example.invalid/${name}` });
  return [asset('installer', `Setup_QtOrder_v${version}.exe`), asset('update', `QtOrder_v${version}.zip`)];
}

/* 依分支（通道）、版本號與 commit 決定這次觸發要建置發布還是只晉升（QtOrder ADR-0033）。
 * 建置前先以假的下載檔案模擬寫入並跑跨欄位規則，版本號不對就在花 CI 時間建置之前失敗。 */
export function planRelease(data, { version, channel, sourceCommit, at = taipeiNow() }) {
  checkArgs({ version, channel, sourceCommit });
  const base = startingPoint(data);
  const existing = base.releases.find((release) => release.version === version);

  if (existing) {
    if (channel === 'preview') fail(`v${version} 已經發布過，預覽版必須先升版號`);
    if (existing.channel === 'stable') fail(`v${version} 已經是穩定版`);
    if (isWithdrawn(existing)) fail(`v${version} 已撤回，不能晉升`);
    if (existing.sourceCommit !== sourceCommit) {
      fail(`v${version} 的預覽版來自 commit ${existing.sourceCommit ?? '（未記錄）'}，與 release/stable 的 ${sourceCommit} 不同；請先升版號`);
    }
    const errors = checkReleaseRules(promoteRelease(base, { version, sourceCommit, at }));
    if (errors.length) fail(`晉升 v${version} 會違反發布規則：${errors.join('；')}`);
    return { action: 'promote', channel: 'stable', previousVersion: null, previousSourceCommit: null };
  }

  if (channel === 'preview' && !latestStable(base.releases)) {
    fail('還沒有任何穩定版：第一個版本請在 release/stable 觸發，直接發布為穩定版（首發）');
  }
  const previous = previousOf(base.releases, version);
  const simulated = addRelease(base, {
    version, channel, sourceCommit, at, summary: `v${version}`, requiresInstaller: false, notes: {}, assets: placeholderAssets(version),
  });
  const errors = checkReleaseRules(simulated);
  if (errors.length) fail(`這次發布會違反發布規則：${errors.join('；')}`);
  return { action: 'publish', channel, previousVersion: previous?.version ?? null, previousSourceCommit: previous?.sourceCommit ?? null };
}

function addRelease(base, { version, channel, sourceCommit, at, summary, requiresInstaller, notes, assets }) {
  const firstStable = !latestStable(base.releases) && channel === 'stable';
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
  return {
    ...base,
    generatedAt: at,
    // 第一個穩定版同時是最低支援版本：最低支援版本必須是未撤回的穩定版
    ...(firstStable && { minimumVersion: version }),
    releases: [release, ...base.releases],
  };
}

/* 新增一個版本。assets.json 由 QtOrder 的 deploy/package.ps1 產生：{ version, assets: [{ name, kind, size, sha256 }] }。 */
export function publishRelease(data, { version, channel, sourceCommit, notesMarkdown, assetsJson, baseUrl, at = taipeiNow() }) {
  checkArgs({ version, channel, sourceCommit });
  const base = startingPoint(data);
  if (base.releases.some((release) => release.version === version)) fail(`v${version} 已經在發布紀錄裡`);
  if (assetsJson.version !== version) fail(`assets.json 的版本 ${assetsJson.version} 與 ${version} 不符`);
  if (!/^https:\/\//.test(baseUrl ?? '')) fail(`下載網址前綴必須是 https：${baseUrl}`);

  const { summary, requiresInstaller, notes } = parseReleaseNotes(notesMarkdown);
  const assets = ['installer', 'update'].map((kind) => {
    const asset = (assetsJson.assets ?? []).find((item) => item.kind === kind);
    if (!asset) fail(`assets.json 缺少 ${kind} 檔案`);
    return { name: asset.name, kind, size: asset.size, sha256: asset.sha256, url: `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(asset.name)}` };
  });
  return addRelease(base, { version, channel, sourceCommit, at, summary, requiresInstaller, notes, assets });
}

/* 把同一個 commit 建出的預覽版改列為穩定版，下載檔案不變。 */
export function promoteRelease(data, { version, sourceCommit, at = taipeiNow() }) {
  checkArgs({ version, sourceCommit });
  const target = data.releases.find((release) => release.version === version);
  if (!target) fail(`發布紀錄裡沒有 v${version}`);
  if (target.channel !== 'preview') fail(`v${version} 不是預覽版`);
  if (isWithdrawn(target)) fail(`v${version} 已撤回，不能晉升`);
  if (target.sourceCommit !== sourceCommit) fail(`v${version} 的 commit 與 release/stable 不同，不能晉升`);
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
  const common = { version: options.version, channel: options.channel, sourceCommit: options['source-commit'], ...(options.at && { at: options.at }) };

  let next;
  if (command === 'plan') {
    console.log(JSON.stringify(planRelease(data, common)));
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
    fail('用法：release-record.js plan|publish|promote --version <v> …（見檔案開頭說明）');
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
