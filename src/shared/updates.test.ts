import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRepoFromUrl, isNewerVersion, parseRelease, parseVersion } from './updates';

test('parses plain versions and tags', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v10.0.12'), [10, 0, 12]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('1.2.3-beta'), null);
  assert.equal(parseVersion('latest'), null);
});

test('compares versions numerically, not as text', () => {
  assert.equal(isNewerVersion('1.10.0', '1.9.9'), true);
  assert.equal(isNewerVersion('v1.1.0', '1.0.9'), true);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
  assert.equal(isNewerVersion('1.1.0', '1.1.0'), false);
  assert.equal(isNewerVersion('1.0.9', '1.1.0'), false);
  assert.equal(isNewerVersion('garbage', '1.0.0'), false);
});

test('reads owner/repo from package.json repository URLs', () => {
  assert.equal(githubRepoFromUrl('https://github.com/Uv2x/uv-link.git'), 'Uv2x/uv-link');
  assert.equal(githubRepoFromUrl('git+https://github.com/Uv2x/uv-link'), 'Uv2x/uv-link');
  assert.equal(githubRepoFromUrl('git@github.com:Uv2x/uv-link.git'), 'Uv2x/uv-link');
  assert.equal(githubRepoFromUrl('github:Uv2x/uv-link'), 'Uv2x/uv-link');
  assert.equal(githubRepoFromUrl('https://gitlab.com/a/b'), null);
});

test('reads a GitHub release with its assets and SHA-256 digests', () => {
  const release = parseRelease({
    tag_name: 'v1.2.0',
    html_url: 'https://github.com/Uv2x/uv-link/releases/tag/v1.2.0',
    body: 'Notes',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'UvLink-PC-Setup.exe',
        browser_download_url: 'https://github.com/Uv2x/uv-link/releases/download/v1.2.0/UvLink-PC-Setup.exe',
        size: 123,
        digest: 'sha256:1FC4766BAC52D7D7558A6C54CF97625A671AE1E9F25890DC44E39B1AC9757993'
      },
      { name: 'UvLink-TV.apk', browser_download_url: 'https://example.invalid/tv.apk', size: 5 },
      { name: 42 }
    ]
  });
  assert.ok(release);
  assert.equal(release.version, '1.2.0');
  assert.equal(release.assets.length, 2);
  assert.equal(release.assets[0].sha256, '1fc4766bac52d7d7558a6c54cf97625a671ae1e9f25890dc44e39b1ac9757993');
  assert.equal(release.assets[1].sha256, null);
});

test('ignores drafts, pre-releases and odd tags', () => {
  assert.equal(parseRelease({ tag_name: 'v1.2.0', draft: true }), null);
  assert.equal(parseRelease({ tag_name: 'v1.2.0', prerelease: true }), null);
  assert.equal(parseRelease({ tag_name: 'nightly' }), null);
  assert.equal(parseRelease(null), null);
});
