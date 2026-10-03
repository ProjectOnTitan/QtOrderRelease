import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildUpdateManifest, minInstallerVersion } from '../assets/js/release-model.js';
import {
  parseReleaseNotes, planRelease, promoteRelease, publishRelease, taipeiNow,
} from '../scripts/release-record.js';
import { validateReleaseData } from '../scripts/validate.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const schema = readJson('data/releases.schema.json');
const mock = readJson('data/releases.json');

const commitA = 'a'.repeat(40);
const commitB = 'b'.repeat(40);
const baseUrl = (version) => `https://github.com/ProjectOnTitan/QtOrderRelease/releases/download/v${version}`;
const assetsJson = (version) => ({
  version,
  assets: [
    { name: `Setup_QtOrder_v${version}.exe`, kind: 'installer', size: 64421888, sha256: 'c'.repeat(64) },
    { name: `QtOrder_v${version}.zip`, kind: 'update', size: 58195968, sha256: 'd'.repeat(64) },
  ],
});
const notes = (summary = '修正與改善', extra = '') => `---\nsummary: ${summary}\nrequiresInstaller: false\n---\n\n## 修正\n- 修正一個問題\n${extra}`;
const day = (n) => `2026-10-${String(n).padStart(2, '0')}T18:00:00+08:00`;

function publish(data, version, channel, { commit = commitA, at, notesMarkdown = notes() } = {}) {
  return publishRelease(data, {
    version, channel, sourceCommit: commit, notesMarkdown, assetsJson: assetsJson(version), baseUrl: baseUrl(version), at,
  });
}

// 觸發時間固定在所有測試資料之後，與實際觸發（現在）的先後關係相同
const plan = (data, args) => planRelease(data, { at: day(9), ...args });

// 首發 1.6.0 後的發布紀錄
const firstRelease = () => publish(mock, '1.6.0', 'stable', { at: day(4) });

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
    assert.throws(() => plan(mock, { version: '1.6.0', channel: 'preview', sourceCommit: commitA }), /請在 release\/stable 觸發/);
    assert.deepEqual(plan(mock, { version: '1.6.0', channel: 'stable', sourceCommit: commitA }),
      { action: 'publish', channel: 'stable', previousVersion: null, previousSourceCommit: null });

    const data = firstRelease();
    assert.equal(data.mock, false);
    assert.equal(data.minimumVersion, '1.6.0');
    assert.equal(data.generatedAt, day(4));
    assert.deepEqual(data.releases.map((r) => r.version), ['1.6.0']);
    assert.equal(data.releases[0].sourceCommit, commitA);
    assert.equal(data.releases[0].releaseUrl, 'https://github.com/ProjectOnTitan/QtOrderRelease/releases/tag/v1.6.0');
    assert.equal(data.releases[0].assets[1].url, `${baseUrl('1.6.0')}/QtOrder_v1.6.0.zip`);
    assert.deepEqual(validateReleaseData(data, schema), []);
  });
});

describe('發布與晉升', () => {
  it('預覽版發布後，同一個 commit 在穩定版觸發時只晉升，下載檔案不變', () => {
    const preview = publish(firstRelease(), '1.7.0', 'preview', { commit: commitB, at: day(5) });
    assert.deepEqual(validateReleaseData(preview, schema), []);
    assert.deepEqual(plan(preview, { version: '1.7.0', channel: 'stable', sourceCommit: commitB }),
      { action: 'promote', channel: 'stable', previousVersion: null, previousSourceCommit: null });

    const promoted = promoteRelease(preview, { version: '1.7.0', sourceCommit: commitB, at: day(7) });
    const release = promoted.releases.find((r) => r.version === '1.7.0');
    assert.equal(release.channel, 'stable');
    assert.equal(release.promotedAt, day(7));
    assert.deepEqual(release.assets, preview.releases.find((r) => r.version === '1.7.0').assets);
    assert.deepEqual(validateReleaseData(promoted, schema), []);
  });

  it('版本號已存在但 commit 不同時，要求先升版號', () => {
    const preview = publish(firstRelease(), '1.7.0', 'preview', { commit: commitB, at: day(5) });
    assert.throws(() => plan(preview, { version: '1.7.0', channel: 'stable', sourceCommit: commitA }), /請先升版號/);
    assert.throws(() => promoteRelease(preview, { version: '1.7.0', sourceCommit: commitA }), /commit/);
  });

  it('預覽版不能重複使用版本號，穩定版也不能重複晉升', () => {
    const data = firstRelease();
    assert.throws(() => plan(data, { version: '1.6.0', channel: 'preview', sourceCommit: commitA }), /先升版號/);
    assert.throws(() => plan(data, { version: '1.6.0', channel: 'stable', sourceCommit: commitA }), /已經是穩定版/);
  });

  it('新版本號在穩定版觸發時是緊急修正，提供前一個版本的 commit 作為比對基準', () => {
    const preview = publish(firstRelease(), '1.7.0', 'preview', { commit: commitB, at: day(5) });
    assert.deepEqual(plan(preview, { version: '1.6.1', channel: 'stable', sourceCommit: commitB }),
      { action: 'publish', channel: 'stable', previousVersion: '1.6.0', previousSourceCommit: commitA });
    const hotfix = publish(preview, '1.6.1', 'stable', { commit: commitB, at: day(6) });
    assert.deepEqual(validateReleaseData(hotfix, schema), []);
  });

  it('版本號比既有的預覽版小時，在建置前就失敗', () => {
    const preview = publish(firstRelease(), '1.7.0', 'preview', { commit: commitB, at: day(5) });
    assert.throws(() => plan(preview, { version: '1.6.5', channel: 'preview', sourceCommit: commitA }), /違反發布規則/);
  });

  it('參數格式不符時拒絕', () => {
    assert.throws(() => plan(mock, { version: '1.6', channel: 'stable', sourceCommit: commitA }), /純數字三段/);
    assert.throws(() => plan(mock, { version: '1.6.0', channel: 'beta', sourceCommit: commitA }), /通道/);
    assert.throws(() => plan(mock, { version: '1.6.0', channel: 'stable', sourceCommit: 'abc' }), /40 碼/);
    assert.throws(() => publishRelease(mock, {
      version: '1.6.0', channel: 'stable', sourceCommit: commitA, notesMarkdown: notes(), assetsJson: assetsJson('1.5.0'), baseUrl: baseUrl('1.6.0'),
    }), /assets\.json 的版本/);
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

    const manifest = buildUpdateManifest(data);
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
