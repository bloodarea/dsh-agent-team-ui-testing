/**
 * Plugin metadata contract (DSH `dsh-app-boot` iconOf).
 *
 * The host embeds the declared icon as a `data:` URL and refuses anything above
 * MAX_ICON_BYTES = 256 KiB, with the media type decided by the file extension. A too-large icon
 * makes the whole plugin metadata read fail ("icon exceeds 256 KiB"), so this test keeps the
 * packaged asset valid instead of discovering it at panel time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const ICON_BYTES_LIMIT = 256 * 1024;
const MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
]);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the declared icon exists, is a regular file and uses an allowed media type', () => {
  assert.equal(typeof pkg.exports?.['./icon'], 'string');
  const iconPath = new URL(`../${pkg.exports['./icon'].replace(/^\.\//, '')}`, import.meta.url);
  const stat = statSync(iconPath);
  assert.equal(stat.isFile(), true);
  assert.ok(MEDIA_TYPES.has(extname(iconPath.pathname).toLowerCase()));
  assert.ok(stat.size <= ICON_BYTES_LIMIT, `icon is ${stat.size} B > ${ICON_BYTES_LIMIT} B`);
});

test('the icon is shipped with the package', () => {
  const declared = pkg.files || [];
  const icon = pkg.exports['./icon'].replace(/^\.\//, '');
  assert.ok(declared.some((entry) => entry === icon || entry === `${icon}/**` || entry === '*'));
});

test('locale display metadata exists and the title is not browser-only', () => {
  // Reported bug: the plugin card said "UI Testing Browser" / "UI 测试浏览器" although the runtime
  // targets frontend GUI debugging across ten environments (Web implemented, nine planned).
  for (const language of ['en', 'zh']) {
    const file = new URL(`../locale/${language}.json`, import.meta.url);
    const meta = JSON.parse(readFileSync(file, 'utf8')).meta;
    assert.equal(typeof meta?.title, 'string', `${language}: meta.title`);
    assert.ok(meta.title.trim().length > 0, `${language}: empty title`);
    assert.equal(typeof meta?.description, 'string', `${language}: meta.description`);
    assert.ok(meta.description.trim().length > 0, `${language}: empty description`);
    assert.ok(!/browser|浏览器/iu.test(meta.title), `${language}: title is browser-only: ${meta.title}`);
  }
});

test('the icon is a decodable PNG with sane dimensions', () => {
  const bytes = readFileSync(new URL(`../${pkg.exports['./icon'].replace(/^\.\//, '')}`, import.meta.url));
  // PNG signature + IHDR width/height (big-endian at offsets 16..24).
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(width >= 128 && height >= 128, `icon is ${width}x${height}`);
  assert.equal(width, height, 'icon must be square');
});
