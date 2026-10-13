// 驗證各產品的發布紀錄並建置 GitHub Pages（ADR-0006：QtOrder 與 QtTrade 各有一份發布紀錄與更新清單）。
//   node scripts/build-site.js              只驗證發布紀錄
//   node scripts/build-site.js --out _site  驗證後輸出網站與各產品的更新清單（update.json、qttrade/update.json）
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTS, buildUpdateManifest, productOf } from '../assets/js/release-model.js';
import { validateReleaseData } from './validate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_FILES = ['index.html', 'assets', 'data'];
const ROBOTS_MARKER = /<!-- build:robots[^>]*-->/;

const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const schema = readJson('data/releases.schema.json');

const records = Object.values(PRODUCTS).map((product) => {
  const data = readJson(product.record);
  const errors = validateReleaseData(data, schema);
  if (productOf(data) !== product) errors.push(`product.id 不是 ${product.id}`);
  if (errors.length) {
    console.error(`${product.record} 驗證失敗：`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`${product.name} 發布紀錄驗證通過：${data.releases.length} 個版本`);
  return { product, data };
});

const outIndex = process.argv.indexOf('--out');
if (outIndex !== -1) {
  const out = resolve(process.argv[outIndex + 1] ?? '_site');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const file of SITE_FILES) cpSync(join(root, file), join(out, file), { recursive: true });

  // 還沒有任何穩定版的產品不產生更新清單；QtTrade 首發前發布中心也不顯示它的區塊
  for (const { product, data } of records) {
    const manifest = buildUpdateManifest(data);
    if (!manifest) {
      console.log(`${product.name} 還沒有穩定版，不產生 ${product.manifest}`);
      continue;
    }
    const path = join(out, product.manifest);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [broker, entry] of Object.entries(manifest.brokers)) {
      console.log(`${product.manifest} ${broker}：穩定版 v${entry.stable.version}、預覽版 v${entry.preview.version}、最低支援版本 v${entry.min_version ?? '（未設定）'}`);
    }
  }

  // 模擬資料不能被搜尋引擎收錄；標記不見時寧可失敗，也不要靜默漏掉 noindex。
  const mock = records.some(({ data }) => data.mock);
  const indexPath = join(out, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  if (!ROBOTS_MARKER.test(html)) throw new Error('index.html 缺少 build:robots 標記');
  writeFileSync(indexPath, html.replace(ROBOTS_MARKER, mock ? '<meta name="robots" content="noindex">' : ''));
  console.log(`已輸出到 ${out}${mock ? '（含模擬資料，已加上 noindex）' : ''}`);
}
