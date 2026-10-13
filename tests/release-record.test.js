import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { BROKERS, buildUpdateManifest, minInstallerVersion } from '../assets/js/release-model.js';
import {
  parseReleaseNotes, planRelease, promoteRelease, publishRelease, releaseBaselines, taipeiNow,
} from '../scripts/release-record.js';
import { validateReleaseData } from '../scripts/validate.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const schema = readJson('data/releases.schema.json');
// 首發前的模擬資料；data/releases.json 首發後是正式紀錄，不能拿來當測試資料
const mock = readJson('tests/fixtures/mock-releases.json');

const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const commitC = 'c'.repeat(40);
const baseUrl = (version) => `https://github.com/ProjectOnTitan/QtOrderRelease/releases/download/v${version}`;
// 打包結果預設三家都有；發布時只取勾選的券商
const assetsJson = (version, brokers = BROKERS) => ({
  version,
  assets: brokers.flatMap(broker => [
    { broker, name: `Setup_QtOrder_${broker}_v${version}.exe`, kind: 'installer', size: 64421888, sha256: 'c'.repeat(64) },
    { broker, name: `QtOrder_${broker}_v${version}.zip`, kind: 'update', size: 58195968, sha256: 'd'.repeat(64) },
  ]),
});
const notes = (summary = '修正與改善', extra = '') => `---\nsummary: ${summary}\nrequiresInstaller: false\n---\n\n## 修正\n- 修正一個問題\n${extra}`;
const day = (n) => `2026-10-${String(n).padStart(2, '0')}T18:00:00+08:00`;

function publish(data, version, channel, { brokers = BROKERS, commit = commitA, at, notesMarkdown = notes(), packaged } = {}) {
  return publishRelease(data, {
    version, channel, sourceCommit: commit, brokers, notesMarkdown, assetsJson: packaged ?? assetsJson(version), baseUrl: baseUrl(version), at,
  });
}

// 觸發時間固定在所有測試資料之後，與實際觸發（現在）的先後關係相同
const planPublish = (data, args) => planRelease(data, { action: 'publish', brokers: BROKERS, sourceCommit: commitA, at: day(9), ...args });
const planPromote = (data, version) => planRelease(data, { action: 'promote', version, at: day(9) });

// 首發 1.6.0 後的發布紀錄
const firstRelease = (brokers = BROKERS) => publish(mock, '1.6.0', 'stable', { brokers, at: day(4) });

describe('版本說明', () => {
  it('讀出摘要、是否需要重新安裝與各類項目', () => {
    const parsed = parseReleaseNotes('﻿---\r\nsummary: 新增批次下單\r\nrequiresInstaller: true\r\n---\r\n## 升級須知\r\n- 請重新執行安裝程式\r\n\r\n## 新功能\r\n- 批次下單\r\n- 使用 `Ctrl+B` 開啟\r\n');
    assert.deepEqual(parsed, {
      summary: '新增批次下單',
      requiresInstaller: true,
      notes: { upgradeNotes: ['請重新執行安裝程式'], features: ['批次下單', '使用 `Ctrl+B` 開啟'] },
    });
  });

  it('格式不符時拒絕', () => {
    const cases = [
      ['## 修正\n- x', /front matter/],
      ['---\nrequiresInstaller: false\n---\n## 修正\n- x', /summary/],
      ['---\nsummary: x\nrequiresInstaller: yes\n---\n## 修正\n- x', /true 或 false/],
      ['---\nsummary: x\nchannel: stable\n---\n## 修正\n- x', /不認得的欄位/],
      ['---\nsummary: x\n---\n## 其他\n- x', /不認得的標題/],
      ['---\nsummary: x\n---\n## 修正\n修正一個問題', /只能有標題/],
      ['---\nsummary: x\n---\n## 修正\n- a\n## 修正\n- b', /重複/],
      ['---\nsummary: x\n---\n## 修正\n', /至少要有一個項目/],
      ['---\nsummary: x\nrequiresInstaller: true\n---\n## 修正\n- x', /升級須知/],
    ];
    for (const [markdown, expected] of cases) assert.throws(() => parseReleaseNotes(markdown), expected, markdown);
  });
});

describe('首發', () => {
  it('第一個版本只能直接發布為穩定版，並清掉模擬資料', () => {
    assert.throws(() => planPublish(mock, { version: '1.6.0', channel: 'preview' }), /還沒有穩定版/);
    assert.deepEqual(planPublish(mock, { version: '1.6.0', channel: 'stable' }), {
      action: 'publish', version: '1.6.0', channel: 'stable', brokers: BROKERS,
      previous: { taishin: null, 'zf-mega': null, capital: null },
    });

    const data = firstRelease();
    assert.equal(data.mock, false);
    assert.deepEqual(data.minimumVersions, { taishin: '1.6.0', 'zf-mega': '1.6.0', capital: '1.6.0' });
    assert.deepEqual(Object.keys(data), ['$schema', 'schemaVersion', 'mock', 'generatedAt', 'minimumVersions', 'product', 'releases']);
    assert.equal(data.generatedAt, day(4));
    assert.deepEqual(data.releases.map((r) => r.version), ['1.6.0']);
    assert.equal(data.releases[0].sourceCommit, commitA);
    assert.equal(data.releases[0].releaseUrl, 'https://github.com/ProjectOnTitan/QtOrderRelease/releases/tag/v1.6.0');
    assert.equal(data.releases[0].assets[1].url, `${baseUrl('1.6.0')}/QtOrder_taishin_v1.6.0.zip`);
    assert.deepEqual(validateReleaseData(data, schema), []);
  });

  it('首發可以只發一家，其他家之後各自首發', () => {
    let data = firstRelease(['capital']);
    assert.deepEqual(data.minimumVersions, { capital: '1.6.0' });
    assert.deepEqual(data.releases[0].assets.map((asset) => asset.name), ['Setup_QtOrder_capital_v1.6.0.exe', 'QtOrder_capital_v1.6.0.zip']);
    assert.deepEqual(Object.keys(buildUpdateManifest(data).brokers), ['capital']);
    assert.deepEqual(validateReleaseData(data, schema), []);

    assert.throws(() => planPublish(data, { version: '1.7.0', channel: 'preview', brokers: ['capital', 'taishin'] }), /taishin 還沒有穩定版/);
    data = publish(data, '1.7.0', 'stable', { brokers: ['taishin'], commit: commitB, at: day(5) });
    assert.deepEqual(data.minimumVersions, { taishin: '1.7.0', capital: '1.6.0' });
    assert.deepEqual(validateReleaseData(data, schema), []);
  });
});

describe('發布與晉升', () => {
  it('預覽版以版本號晉升，整個版本一起晉升、下載檔案不變', () => {
    const preview = publish(firstRelease(), '1.7.0', 'preview', { brokers: ['taishin', 'capital'], commit: commitB, at: day(5) });
    assert.deepEqual(validateReleaseData(preview, schema), []);
    assert.deepEqual(planPromote(preview, '1.7.0'), { action: 'promote', version: '1.7.0', brokers: ['taishin', 'capital'] });

    const promoted = promoteRelease(preview, { version: '1.7.0', at: day(7) });
    const release = promoted.releases.find((r) => r.version === '1.7.0');
    assert.equal(release.channel, 'stable');
    assert.equal(release.promotedAt, day(7));
    assert.deepEqual(release.assets, preview.releases.find((r) => r.version === '1.7.0').assets);
    assert.deepEqual(validateReleaseData(promoted, schema), []);

    const manifest = buildUpdateManifest(promoted).brokers;
    assert.equal(manifest.taishin.stable.version, '1.7.0');
    assert.equal(manifest.capital.stable.version, '1.7.0');
    assert.equal(manifest['zf-mega'].stable.version, '1.6.0');
  });

  it('晉升不了的情況', () => {
    const preview = publish(firstRelease(), '1.7.0', 'preview', { commit: commitB, at: day(5) });
    assert.throws(() => planPromote(preview, '1.8.0'), /沒有 v1\.8\.0/);
    assert.throws(() => planPromote(preview, '1.6.0'), /已經是穩定版/);
    preview.releases[0].withdrawn = { at: day(6), reason: '問題' };
    assert.throws(() => planPromote(preview, '1.7.0'), /已撤回/);
    assert.throws(() => planPromote(mock, '1.8.0'), /模擬資料/);
  });

  it('已發布的版本號不能再用，也不補發其他券商', () => {
    const data = firstRelease(['capital']);
    assert.throws(() => planPublish(data, { version: '1.6.0', channel: 'stable', brokers: ['capital'] }), /已經發布過/);
    assert.throws(() => planPublish(data, { version: '1.6.0', channel: 'stable', brokers: ['taishin'] }), /不補發其他券商/);
    assert.throws(() => publish(data, '1.6.0', 'stable', { brokers: ['taishin'] }), /已經發布過/);
  });

  it('緊急修正直接發布為穩定版，提供各家上一個版本的 commit 作為比對基準', () => {
    let data = publish(firstRelease(), '1.7.0', 'preview', { brokers: ['taishin', 'capital'], commit: commitB, at: day(5) });
    assert.deepEqual(planPublish(data, { version: '1.7.1', channel: 'stable', brokers: ['zf-mega', 'capital'], sourceCommit: commitC }).previous, {
      'zf-mega': { version: '1.6.0', sourceCommit: commitA },
      capital: { version: '1.7.0', sourceCommit: commitB },
    });
    data = publish(data, '1.7.1', 'stable', { brokers: ['capital'], commit: commitC, at: day(6) });
    assert.deepEqual(validateReleaseData(data, schema), []);
    const manifest = buildUpdateManifest(data).brokers;
    assert.equal(manifest.capital.stable.version, '1.7.1');
    assert.equal(manifest.capital.preview.version, '1.7.1');
    assert.equal(manifest.taishin.stable.version, '1.6.0');
    assert.equal(manifest.taishin.preview.version, '1.7.0');
  });

  it('版本號比已發布的版本小時，在下載打包結果之前就失敗', () => {
    const preview = publish(firstRelease(), '1.7.0', 'preview', { brokers: ['capital'], commit: commitB, at: day(5) });
    assert.throws(() => planPublish(preview, { version: '1.6.5', channel: 'stable', brokers: ['taishin'] }), /違反發布規則/);
  });

  it('參數格式不符時拒絕', () => {
    assert.throws(() => planPublish(mock, { version: '1.6', channel: 'stable' }), /純數字三段/);
    assert.throws(() => planPublish(mock, { version: '1.6.0', channel: 'beta' }), /通道/);
    assert.throws(() => planPublish(mock, { version: '1.6.0', channel: 'stable', sourceCommit: 'abc' }), /40 碼/);
    assert.throws(() => planPublish(mock, { version: '1.6.0', channel: 'stable', brokers: [] }), /至少要勾選一家/);
    assert.throws(() => planPublish(mock, { version: '1.6.0', channel: 'stable', brokers: ['mega'] }), /不認得的券商：mega/);
    assert.throws(() => planPublish(mock, { version: '1.6.0', channel: 'stable', brokers: ['capital', 'capital'] }), /券商重複/);
    assert.throws(() => planRelease(mock, { action: 'withdraw', version: '1.6.0' }), /動作只能是/);
    assert.throws(() => publishRelease(mock, {
      version: '1.6.0', channel: 'stable', sourceCommit: commitA, brokers: BROKERS, notesMarkdown: notes(), assetsJson: assetsJson('1.5.0'), baseUrl: baseUrl('1.6.0'),
    }), /assets\.json 的版本/);
  });
});

describe('打包結果', () => {
  it('只取勾選券商的檔案，其他券商的檔案忽略', () => {
    const data = publish(mock, '1.6.0', 'stable', { brokers: ['zf-mega'], at: day(4) });
    assert.deepEqual(data.releases[0].assets.map((asset) => asset.broker), ['zf-mega', 'zf-mega']);
  });

  it('勾選的券商不在打包結果裡時拒絕', () => {
    assert.throws(() => publish(mock, '1.6.0', 'stable', { brokers: ['taishin', 'capital'], packaged: assetsJson('1.6.0', ['taishin']), at: day(4) }),
      /assets\.json 沒有 capital 的檔案/);
  });

  it('缺檔、重複種類、錯版本檔名、錯大小或雜湊皆在記錄發布前拒絕', () => {
    for (const change of [
      assets => assets.pop(),
      assets => { assets[0] = { ...assets[2] }; },
      assets => { assets[0].name = 'Setup_QtOrder_taishin_v9.0.0.exe'; },
      assets => { assets[0].size = 0; },
      assets => { assets[0].sha256 = 'bad'; },
    ]) {
      const packaged = assetsJson('1.6.0');
      change(packaged.assets);
      assert.throws(() => publish(mock, '1.6.0', 'stable', { packaged, at: day(4) }));
    }
  });
});

describe('比較基準', () => {
  it('模擬資料沒有任何正式版本，各家都沒有基準', () => {
    assert.deepEqual(releaseBaselines(mock, { version: '1.8.0' }), {
      versionPublished: false, brokers: { taishin: null, 'zf-mega': null, capital: null },
    });
  });

  it('各家取包含它的最高版本，已撤回的也算', () => {
    let data = firstRelease(['capital', 'taishin']);
    data = publish(data, '1.7.0', 'preview', { brokers: ['capital'], commit: commitB, at: day(5) });
    data.releases[0].withdrawn = { at: day(6), reason: '問題' };
    assert.deepEqual(releaseBaselines(data, { version: '1.7.0' }), {
      versionPublished: true,
      brokers: {
        taishin: { version: '1.6.0', sourceCommit: commitA },
        'zf-mega': null,
        capital: { version: '1.7.0', sourceCommit: commitB },
      },
    });
    assert.equal(releaseBaselines(data, { version: '1.8.0' }).versionPublished, false);
    assert.throws(() => releaseBaselines(data, { version: 'v1.8.0' }), /純數字三段/);
  });
});

describe('需要重新安裝', () => {
  it('更新清單帶上不超過該版本、標示過的最高版本，已撤回的也算', () => {
    let data = firstRelease();
    data = publish(data, '1.7.0', 'preview', { at: day(5), notesMarkdown: '---\nsummary: 換元件\nrequiresInstaller: true\n---\n## 升級須知\n- 重新安裝\n' });
    data = publish(data, '1.8.0', 'preview', { at: day(6) });
    data.releases.find((r) => r.version === '1.7.0').withdrawn = { at: day(6), reason: '問題' };

    assert.equal(minInstallerVersion(data.releases, { version: '1.6.0' }), null);
    assert.equal(minInstallerVersion(data.releases, { version: '1.8.0' }), '1.7.0');

    const manifest = buildUpdateManifest(data).brokers.taishin;
    assert.equal(manifest.stable.version, '1.6.0');
    assert.equal('min_installer_version' in manifest.stable, false);
    assert.equal(manifest.preview.version, '1.8.0');
    assert.equal(manifest.preview.min_installer_version, '1.7.0');
    assert.deepEqual(validateReleaseData(data, schema), []);
  });
});

describe('時間', () => {
  it('以台北時間輸出', () => {
    assert.equal(taipeiNow(new Date('2026-10-03T16:30:05Z')), '2026-10-04T00:30:05+08:00');
  });
});
