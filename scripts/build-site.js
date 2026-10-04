// 驗證發布紀錄並建置 GitHub Pages。
//   node scripts/build-site.js              只驗證 data/releases.json
//   node scripts/build-site.js --out _site  驗證後輸出網站與更新清單（update.json）
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUpdateManifest } from '../assets/js/release-model.js';
import { validateReleaseData } from './validate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_FILES = ['index.html', 'assets', 'data'];
const MANIFEST_FILE = 'update.json';
const ROBOTS_MARKER = /<!-- build:robots[^>]*-->/;

const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const data = readJson('data/releases.json');
const errors = validateReleaseData(data, readJson('data/releases.schema.json'));
if (errors.length) {
  console.error('發布紀錄驗證失敗：');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`發布紀錄驗證通過：${data.releases.length} 個版本`);

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1) {
  const out = resolve(process.argv[outIndex + 1] ?? '_site');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const file of SITE_FILES) cpSync(join(root, file), join(out, file), { recursive: true });

  const manifest = buildUpdateManifest(data);
  if (manifest) {
    writeFileSync(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`更新清單：穩定版 v${manifest.brokers.taishin.stable.version}、預覽版 v${manifest.brokers.taishin.preview.version}、最低支援版本 v${manifest.brokers.taishin.min_version}`);
  }

  // 模擬資料不能被搜尋引擎收錄；標記不見時寧可失敗，也不要靜默漏掉 noindex。
  const indexPath = join(out, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  if (!ROBOTS_MARKER.test(html)) throw new Error('index.html 缺少 build:robots 標記');
  writeFileSync(indexPath, html.replace(ROBOTS_MARKER, data.mock ? '<meta name="robots" content="noindex">' : ''));
  console.log(`已輸出到 ${out}${data.mock ? '（模擬資料，已加上 noindex）' : ''}`);
}
