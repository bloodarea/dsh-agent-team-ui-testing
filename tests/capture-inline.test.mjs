/**
 * Inline base64 budget for `browser_screenshot` (index.js `inlineImageDelivery`).
 *
 * A full-page 16M-pixel capture can encode to tens of MiB of base64. When the attachment service
 * is unavailable the fallback render would hand that whole string to the model, so above the cap the
 * inline copy is dropped while the attachment fields (and the file) stay intact. These tests pin the
 * boundary, the reported byte count and the "no inline image" cases; the warning wiring is exercised
 * by the capture path itself (`addCaptureWarning` rejects unknown codes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_INLINE_BASE64_LIMIT, inlineImageDelivery } from '../index.js';

test('the documented limit is 24 MiB', () => {
  assert.equal(IMAGE_INLINE_BASE64_LIMIT, 24 * 1024 * 1024);
});

test('a small payload is returned unchanged', () => {
  const out = inlineImageDelivery('aGVsbG8=');
  assert.deepEqual(out, { image: 'aGVsbG8=', omitted: false, bytes: 8 });
});

test('the boundary is inclusive: exactly the limit is still delivered', () => {
  const payload = 'a'.repeat(IMAGE_INLINE_BASE64_LIMIT);
  const out = inlineImageDelivery(payload);
  assert.equal(out.omitted, false);
  assert.equal(out.image, payload);
  assert.equal(out.bytes, IMAGE_INLINE_BASE64_LIMIT);
});

test('one character above the limit omits the inline copy but reports its size', () => {
  const payload = 'a'.repeat(IMAGE_INLINE_BASE64_LIMIT + 1);
  const out = inlineImageDelivery(payload);
  assert.equal(out.omitted, true);
  assert.equal(out.image, null);
  assert.equal(out.bytes, IMAGE_INLINE_BASE64_LIMIT + 1);
});

test('a custom limit is honoured', () => {
  assert.deepEqual(inlineImageDelivery('abcd', 4), { image: 'abcd', omitted: false, bytes: 4 });
  assert.deepEqual(inlineImageDelivery('abcde', 4), { image: null, omitted: true, bytes: 5 });
});

test('non-string payloads never pretend to be inline images', () => {
  for (const value of [null, undefined, 42, {}, Buffer.from('x')]) {
    assert.deepEqual(inlineImageDelivery(value), { image: null, omitted: false, bytes: 0 });
  }
});
