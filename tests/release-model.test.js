import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  buildUpdateManifest, checkReleaseRules, compareVersions, latestPreview, latestStable,
} from '../assets/js/release-model.js';
import { validateReleaseData } from '../scripts/validate.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const schema = readJson('data/releases.schema.json');
const mock = readJson('data/releases.json');

function release(version, channel, { publishedAt, promotedAt, withdrawn } = {}) {
  const asset = (kind, name) => ({
    name, kind, size: 1024, sha256: `${kind === 'installer' ? 'a' : 'b'}`.repeat(64), url: `https://example.test/${name}`,
  });
  return {
    version,
    channel,
    publishedAt: publishedAt ?? '2026-09-01T00:00:00+08:00',
    ...(promotedAt && { promotedAt }),
    ...(withdrawn && { withdrawn }),
    summary: `v${version}`,
    assets: ['taishin', 'zf-mega', 'capital'].flatMap(broker => [{ ...asset('installer', `Setup_QtOrder_${broker}_v${version}.exe`), broker }, { ...asset('update', `QtOrder_${broker}_v${version}.zip`), broker }]),
  };
}

const record = (releases, minimumVersion = '1.0.0') => ({
  schemaVersion: 2, generatedAt: '2026-10-01T00:00:00+08:00', product: { name: 'QtOrder' }, minimumVersion, releases,
});

const day = (n) => `2026-09-${String(n).padStart(2, '0')}T00:00:00+08:00`;

describe('compareVersions', () => {
  it('逐段比較數字而非字串', () => {
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
    assert.ok(compareVersions('1.6.2', '1.7.0') < 0);
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  });
});

describe('最新版本', () => {
  it('穩定版取未撤回的最高版本號，而非最晚發布的', () => {
    const releases = [
      release('1.0.0', 'stable', { publishedAt: day(1), promotedAt: day(2) }),
      release('1.1.0', 'stable', { publishedAt: day(3), promotedAt: day(4), withdrawn: { at: day(5), reason: '問題' } }),
      release('1.0.1', 'stable', { publishedAt: day(6) }),
    ];
    assert.equal(latestStable(releases).version, '1.0.1');
  });

  it('預覽版不比穩定版新時不推薦任何預覽版', () => {
    const releases = [
      release('1.0.0', 'preview', { publishedAt: day(1) }),
      release('1.1.0', 'stable', { publishedAt: day(2), promotedAt: day(3) }),
    ];
    assert.equal(latestPreview(releases), null);
    assert.equal(latestPreview([...releases, release('1.2.0', 'preview', { publishedAt: day(4) })]).version, '1.2.0');
  });
});

describe('更新清單', () => {
  it('預覽版沒有更新的版本時指向穩定版，避免客戶被降級', () => {
    const manifest = buildUpdateManifest(record([
      release('1.0.0', 'preview', { publishedAt: day(1) }),
      release('1.1.0', 'stable', { publishedAt: day(2), promotedAt: day(3) }),
    ], '1.1.0'));
    assert.equal(manifest.brokers.taishin.stable.version, '1.1.0');
    assert.equal(manifest.brokers.taishin.preview.version, '1.1.0');
    assert.equal(manifest.brokers.taishin.min_version, '1.1.0');
  });

  it('沿用啟動器既有欄位，並附上更新套件的雜湊與大小', () => {
    const manifest = buildUpdateManifest(mock);
    assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'brokers']);
    assert.deepEqual(Object.keys(manifest.brokers), ['taishin', 'zf-mega', 'capital']);
    assert.equal(manifest.brokers.taishin.stable.version, '1.7.1');
    assert.equal(manifest.brokers.taishin.preview.version, '1.8.0');
    assert.match(manifest.brokers.taishin.stable.url, /QtOrder_taishin_v1\.7\.1\.zip$/);
    assert.match(manifest.brokers.taishin.stable.sha256, /^[0-9a-f]{64}$/);
    assert.ok(manifest.brokers.taishin.stable.size > 0);
  });
});

describe('發布紀錄驗證', () => {
  it('模擬資料通過完整驗證', () => {
    assert.deepEqual(validateReleaseData(mock, schema), []);
  });

  it('拒絕預覽標記與不認得的檔案種類', () => {
    const data = structuredClone(mock);
    data.releases[0].version = '1.8.0-preview.1';
    data.releases[1].assets[1].kind = 'portable';
    assert.equal(validateReleaseData(data, schema).length, 2);
  });

  it('擋下跨欄位規則的錯誤', () => {
    const cases = [
      [[release('1.0.0', 'stable'), release('1.0.0', 'stable', { publishedAt: day(2) })], '1.0.0', /重複/],
      [[release('1.0.0', 'stable'), release('1.1.0', 'preview', { publishedAt: day(2), promotedAt: day(3) })], '1.0.0', /只有穩定版/],
      [[release('1.0.0', 'stable', { publishedAt: day(5), promotedAt: day(4) })], '1.0.0', /晉升時間早於/],
      [[release('1.2.0', 'stable', { publishedAt: day(1), promotedAt: day(2) }), release('1.1.0', 'stable', { publishedAt: day(3) })], '1.2.0', /穩定版的版本號必須/],
      [[release('1.0.0', 'stable'), release('1.1.0', 'stable', { publishedAt: day(2), withdrawn: { at: day(3), reason: 'x' } })], '1.1.0', /最低支援版本/],
      [[release('1.0.0', 'preview')], '1.0.0', /至少需要一個未撤回的穩定版/],
    ];
    for (const [releases, minimum, expected] of cases) {
      const errors = checkReleaseRules(record(releases, minimum));
      assert.ok(errors.some((error) => expected.test(error)), `預期 ${expected}，實際：${errors.join('；') || '無錯誤'}`);
    }
  });

  it('安裝程式與更新套件缺一不可', () => {
    const data = record([release('1.0.0', 'stable')]);
    data.releases[0].assets[1].kind = 'installer';
    assert.ok(checkReleaseRules(data).some((error) => /update/.test(error)));
  });

  it('還沒有任何版本時不要求最低支援版本', () => {
    const data = record([]);
    delete data.minimumVersion;
    assert.deepEqual(validateReleaseData(data, schema), []);
  });
});

describe('券商交付邊界', () => {
  it('三家的清單只含自身下載檔案，最低版本規則一致', () => {
    const manifest = buildUpdateManifest(mock);
    for (const broker of ['taishin', 'zf-mega', 'capital']) {
      const selected = manifest.brokers[broker];
      for (const track of ['stable', 'preview']) {
        assert.equal(selected[track].broker, broker);
        assert.ok(selected[track].url.includes('_' + broker + '_'));
      }
      assert.equal(selected.min_version, mock.minimumVersion);
    }
  });
  it('缺一家、重複種類及未知券商都不能發布', () => {
    for (const change of [
      assets => assets.pop(),
      assets => { assets[0] = { ...assets[1] }; },
      assets => { assets[0].broker = 'mega'; },
    ]) {
      const data = structuredClone(mock);
      change(data.releases[0].assets);
      assert.ok(validateReleaseData(data, schema).length > 0);
    }
  });
});
