import { posix, win32 } from 'node:path';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 128 * 1024 * 1024;
const MAX_REFERENCES = 64;

export function referenceError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function imageType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (/^GIF8[79]a$/u.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.toString('latin1', 4, 8) === 'ftyp' && /^(avif|avis)$/u.test(bytes.toString('latin1', 8, 12))) return 'image/avif';
  return null;
}

function readMetadata(req, header, limit) {
  const value = req.headers[header];
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded.length <= limit && !/[\u0000-\u001f\u007f]/u.test(decoded)) return decoded;
    } catch { /* handled as invalid metadata */ }
  }
  throw referenceError('INVALID_ARGUMENT', '参考图文件信息无效。', 400);
}

export async function readBlenderReference(req, signal) {
  const name = readMetadata(req, 'x-dsh-blender-reference-name', 255);
  const path = readMetadata(req, 'x-dsh-blender-reference-path', 4096);
  if (!name || /[/\\]/u.test(name) || (path && !posix.isAbsolute(path) && !win32.isAbsolute(path))) {
    throw referenceError('INVALID_ARGUMENT', '参考图文件信息无效。', 400);
  }
  if (req.headers['content-type'] !== 'application/octet-stream') {
    throw referenceError('INVALID_ARGUMENT', '参考图上传格式无效。', 400);
  }
  const tooLarge = () => referenceError('BLENDER_REFERENCE_TOO_LARGE', '参考图不能超过 32 MiB。', 413);
  if (Number(req.headers['content-length']) > MAX_IMAGE_BYTES) {
    req.resume();
    throw tooLarge();
  }
  const chunks = [];
  let size = 0;
  const abort = () => req.destroy();
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        req.resume();
        throw tooLarge();
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  signal.throwIfAborted();
  const bytes = Buffer.concat(chunks, size);
  const contentType = imageType(bytes);
  if (!contentType) throw referenceError('BLENDER_REFERENCE_FORMAT', '请选择 PNG、JPEG、WebP、GIF、BMP 或 AVIF 图片。', 415);
  // The desktop path is display metadata only. Preview the bytes the user selected.
  return { name, path: path || null, contentType, bytes };
}

export function createBlenderReferences(generation) {
  const images = new Map();
  let nextId = 1;
  let totalBytes = 0;
  const list = () => ({ generation, items: Array.from(images.values(), ({ item }) => item) });
  return {
    generation,
    list,
    add(reference) {
      if (images.size >= MAX_REFERENCES || totalBytes + reference.bytes.length > MAX_REFERENCE_BYTES) {
        throw referenceError('BLENDER_REFERENCE_LIMIT', '每个 Blender 实例最多添加 64 张参考图，总大小不能超过 128 MiB。', 413);
      }
      const item = { id: nextId++, name: reference.name, path: reference.path };
      images.set(item.id, { item, bytes: reference.bytes, contentType: reference.contentType });
      totalBytes += reference.bytes.length;
      return item;
    },
    get: (id) => images.get(id),
    remove(id) {
      const image = images.get(id);
      if (image) {
        images.delete(id);
        totalBytes -= image.bytes.length;
      }
      return list();
    },
  };
}
