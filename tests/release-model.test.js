import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  BROKERS, brokersOf, buildUpdateManifest, checkReleaseRules, compareVersions, latestPreview, latestStable, minInstallerVersion,
} from '../assets/js/release-model.js';
import { validateReleaseData } from '../scripts/validate.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const schema = readJson('data/releases.schema.json');
// 首發前的模擬資料；data/releases.json 首發後是正式紀錄，不能拿來當測試資料
const mock = readJson('tests/fixtures/mock-releases.json');

function release(version, channel, { publishedAt, promotedAt, withdrawn, requiresInstaller, brokers = BROKERS } = {}) {
  const asset = (kind, name) => ({
    name, kind, size: 1024, sha256: `${kind === 'installer' ? 'a' : 'b'}`.repeat(64), url: `https://example.test/${name}`,
  });
  return {
    version,
    channel,
    publishedAt: publishedAt ?? '2026-09-01T00:00:00+08:00',
    ...(promotedAt && { promotedAt }),
    ...(withdrawn && { withdrawn }),
    ...(requiresInstaller && { requiresInstaller }),
    summary: `v${version}`,
    assets: brokers.flatMap(broker => [{ ...asset('installer', `Setup_QtOrder_${broker}_v${version}.exe`), broker }, { ...asset('update', `QtOrder_${broker}_v${version}.zip`), broker }]),
  };
}

// minimumVersions 預設替每一家都設成同一個版本；個別券商不同時直接傳物件
const record = (releases, minimum = '1.0.0') => ({
  schemaVersion: 3,
  generatedAt: '2026-10-01T00:00:00+08:00',
  product: { name: 'QtOrder' },
  minimumVersions: typeof minimum === 'string' ? Object.fromEntries(BROKERS.map((broker) => [broker, minimum])) : minimum,
  releases,
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

  it('各家只看包含自己的版本', () => {
    const releases = [
      release('1.0.0', 'stable', { publishedAt: day(1) }),
      release('1.1.0', 'stable', { publishedAt: day(2), brokers: ['capital'] }),
      release('1.2.0', 'preview', { publishedAt: day(3), brokers: ['taishin'] }),
    ];
    assert.deepEqual(brokersOf(releases[1]), ['capital']);
    assert.equal(latestStable(releases, 'capital').version, '1.1.0');
    assert.equal(latestStable(releases, 'taishin').version, '1.0.0');
    assert.equal(latestPreview(releases, 'taishin').version, '1.2.0');
    assert.equal(latestPreview(releases, 'capital'), null);
    assert.equal(latestStable(releases).version, '1.1.0');
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
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(Object.keys(manifest.brokers), ['taishin', 'zf-mega', 'capital']);
    assert.deepEqual(Object.keys(manifest.brokers.taishin), ['stable', 'preview', 'min_version']);
    assert.match(manifest.brokers.taishin.stable.url, /QtOrder_taishin_v1\.6\.2\.zip$/);
    assert.match(manifest.brokers.taishin.stable.sha256, /^[0-9a-f]{64}$/);
    assert.ok(manifest.brokers.taishin.stable.size > 0);
  });

  it('模擬資料裡各家的最新版本不同', () => {
    const versions = Object.fromEntries(Object.entries(buildUpdateManifest(mock).brokers)
      .map(([broker, entry]) => [broker, `${entry.stable.version}/${entry.preview.version}`]));
    assert.deepEqual(versions, { taishin: '1.6.2/1.8.0', 'zf-mega': '1.6.2/1.8.0', capital: '1.7.1/1.7.1' });
  });

  it('只發布一家時，其他家的清單不變', () => {
    const before = record([release('1.0.0', 'stable', { publishedAt: day(1) })]);
    const after = record([...before.releases, release('1.1.0', 'stable', { publishedAt: day(2), brokers: ['capital'] })]);
    assert.deepEqual(validateReleaseData(after, schema), []);
    const [old, next] = [buildUpdateManifest(before), buildUpdateManifest(after)];
    assert.equal(next.brokers.capital.stable.version, '1.1.0');
    assert.deepEqual(next.brokers.taishin, old.brokers.taishin);
    assert.deepEqual(next.brokers['zf-mega'], old.brokers['zf-mega']);
  });

  it('還沒有穩定版的券商不列入；沒有任何穩定版時不產生清單', () => {
    const data = record([release('1.0.0', 'stable', { publishedAt: day(1), brokers: ['capital'] })], { capital: '1.0.0' });
    assert.deepEqual(validateReleaseData(data, schema), []);
    assert.deepEqual(Object.keys(buildUpdateManifest(data).brokers), ['capital']);
    assert.equal(buildUpdateManifest(record([], {})), null);
  });

  it('min_installer_version 只看包含這家的版本', () => {
    const data = record([
      release('1.0.0', 'stable', { publishedAt: day(1) }),
      release('1.1.0', 'stable', { publishedAt: day(2), brokers: ['capital'], requiresInstaller: true }),
      release('1.2.0', 'stable', { publishedAt: day(3), brokers: ['taishin'] }),
    ]);
    assert.equal(minInstallerVersion(data.releases, { version: '1.2.0' }, 'taishin'), null);
    const manifest = buildUpdateManifest(data);
    assert.equal('min_installer_version' in manifest.brokers.taishin.stable, false);
    assert.equal(manifest.brokers.capital.stable.min_installer_version, '1.1.0');
  });
});

describe('發布紀錄驗證', () => {
  it('模擬資料通過完整驗證', () => {
    assert.deepEqual(validateReleaseData(mock, schema), []);
  });

  it('正式的發布紀錄通過完整驗證', () => {
    assert.deepEqual(validateReleaseData(readJson('data/releases.json'), schema), []);
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
      [[release('1.2.0', 'stable', { publishedAt: day(1), promotedAt: day(2) }), release('1.1.0', 'stable', { publishedAt: day(3) })], '1.2.0', /發布的版本號必須/],
      [[release('1.0.0', 'stable'), release('1.1.0', 'stable', { publishedAt: day(2), withdrawn: { at: day(3), reason: 'x' } })], '1.1.0', /最低支援版本/],
      [[release('1.0.0', 'preview')], '1.0.0', /至少需要一個未撤回的穩定版/],
    ];
    for (const [releases, minimum, expected] of cases) {
      const errors = checkReleaseRules(record(releases, minimum));
      assert.ok(errors.some((error) => expected.test(error)), `預期 ${expected}，實際：${errors.join('；') || '無錯誤'}`);
    }
  });

  it('版本號不分券商都隨發布時間遞增', () => {
    const errors = checkReleaseRules(record([
      release('1.0.0', 'stable', { publishedAt: day(1) }),
      release('1.2.0', 'preview', { publishedAt: day(2), brokers: ['capital'] }),
      release('1.1.0', 'preview', { publishedAt: day(3), brokers: ['taishin'] }),
    ]));
    assert.ok(errors.some((error) => /v1\.1\.0：發布的版本號必須比先前的 v1\.2\.0 大/.test(error)), errors.join('；'));
  });

  it('另一家已晉升較新的版本時，仍能晉升較舊的版本；同一家不能倒退', () => {
    const releases = (olderBrokers) => [
      release('1.0.0', 'stable', { publishedAt: day(1) }),
      release('1.1.0', 'stable', { publishedAt: day(2), promotedAt: day(5), brokers: olderBrokers }),
      release('1.2.0', 'stable', { publishedAt: day(3), promotedAt: day(4), brokers: ['taishin'] }),
    ];
    assert.deepEqual(checkReleaseRules(record(releases(['capital']))), []);
    assert.ok(checkReleaseRules(record(releases(['taishin']))).some((error) => /taishin 穩定版的版本號必須/.test(error)));
  });

  it('最低支援版本按券商檢查', () => {
    const releases = [
      release('1.0.0', 'stable', { publishedAt: day(1), brokers: ['taishin', 'capital'] }),
      release('1.1.0', 'stable', { publishedAt: day(2), brokers: ['capital'] }),
    ];
    const cases = [
      [{ taishin: '1.1.0', capital: '1.1.0' }, /taishin：最低支援版本 v1\.1\.0 必須是一個包含這家的未撤回穩定版/],
      [{ capital: '1.1.0' }, /taishin：缺少最低支援版本/],
      [{ taishin: '1.0.0', capital: '1.0.0', 'zf-mega': '1.0.0' }, /zf-mega：還沒有任何版本/],
    ];
    assert.deepEqual(checkReleaseRules(record(releases, { taishin: '1.0.0', capital: '1.1.0' })), []);
    for (const [minimum, expected] of cases) {
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
    delete data.minimumVersions;
    assert.deepEqual(validateReleaseData(data, schema), []);
  });
});

describe('券商交付邊界', () => {
  it('各家的清單只含自身下載檔案與自己的最低支援版本', () => {
    const manifest = buildUpdateManifest(mock);
    for (const broker of BROKERS) {
      const selected = manifest.brokers[broker];
      for (const track of ['stable', 'preview']) {
        assert.equal(selected[track].broker, broker);
        assert.ok(selected[track].url.includes('_' + broker + '_'));
      }
      assert.equal(selected.min_version, mock.minimumVersions[broker]);
    }
  });

  it('缺檔、重複種類、未知券商與沒有任何券商都不能發布', () => {
    for (const change of [
      assets => assets.pop(),
      assets => { assets[0] = { ...assets[1] }; },
      assets => { assets[0].broker = 'mega'; },
      assets => assets.splice(0),
    ]) {
      const data = structuredClone(mock);
      change(data.releases[0].assets);
      assert.ok(validateReleaseData(data, schema).length > 0);
    }
  });
});
