/**
 * Rasterize the panel's accepted annotation document in a CDP isolated world.
 * This function is serialized into Chromium: it must close over no Host values. Its detached
 * OffscreenCanvas never changes the target DOM, styles, focus, viewport or preview, and needs no
 * image/network loads (including on pages with img-src 'none'). Geometry and styles mirror
 * client.js renderAnnotShape/annotArrowGeometry; the input is Host-normalized shape data only.
 */
export async function renderAnnotationOverlay({ shapes, region, width, height }) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('annotation 2d context unavailable');
  ctx.setTransform(width / region.width, 0, 0, height / region.height,
    -region.x * width / region.width, -region.y * height / region.height);
  const rounded = value => Math.round(value * 100) / 100;
  for (const shape of shapes) {
    ctx.fillStyle = shape.color;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.strokeWidth;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    if (shape.type === 'rect' || shape.type === 'circle') {
      if (shape.type === 'rect') ctx.rect(shape.x, shape.y, shape.width, shape.height);
      else ctx.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2);
      if (shape.fill) ctx.fill();
      if (shape.stroke) ctx.stroke();
    } else if (shape.type === 'line') {
      ctx.lineCap = 'round';
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
    } else if (shape.type === 'arrow') {
      const dx = shape.x2 - shape.x1, dy = shape.y2 - shape.y1;
      const length = Math.hypot(dx, dy);
      const headLength = Math.min(3 * shape.strokeWidth, length);
      const headWidth = Math.min(2 * shape.strokeWidth, length);
      const ux = length ? dx / length : 0, uy = length ? dy / length : 0;
      const bx = shape.x2 - ux * headLength, by = shape.y2 - uy * headLength;
      ctx.lineCap = 'round';
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(bx, by);
      ctx.stroke();
      if (length) {
        // The panel rounds polygon/polyline point strings to two decimal places.
        ctx.beginPath();
        ctx.moveTo(rounded(shape.x2), rounded(shape.y2));
        ctx.lineTo(rounded(bx - uy * headWidth / 2), rounded(by + ux * headWidth / 2));
        ctx.lineTo(rounded(bx + uy * headWidth / 2), rounded(by - ux * headWidth / 2));
        ctx.closePath();
        ctx.fill();
      }
    } else if (shape.type === 'brush') {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      shape.points.forEach((point, index) => {
        // Host wire data stores a point as [x,y]; the panel converts it to an object only
        // when importing into its local editor. Render the accepted wire document directly.
        if (index) ctx.lineTo(rounded(point[0]), rounded(point[1]));
        else ctx.moveTo(rounded(point[0]), rounded(point[1]));
      });
      ctx.stroke();
    } else if (shape.type === 'text') {
      ctx.font = '400 20px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textBaseline = 'alphabetic';
      // SVG text-before-edge aligns the font's ascent box, whereas Canvas 'top' aligns its em
      // square. Use font metrics so CJK/fallback fonts retain the panel's baseline.
      // SVG's default white-space processing collapses interior spaces and trims the edges.
      const text = shape.text.replace(/[\t\r\n]/g, ' ').replace(/ +/g, ' ').trim();
      const ascent = ctx.measureText(text).fontBoundingBoxAscent;
      ctx.fillText(text, shape.x, shape.y + ascent);
    }
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return { base64: btoa(binary), width, height };
}

/** Source-over a transparent annotation raster onto the already-captured browser pixels. */
export function compositeAnnotationPixels(page, overlay) {
  if (page.width !== overlay.width || page.height !== overlay.height) {
    throw new Error('annotation raster dimensions differ from page capture');
  }
  // Chromium emits RGBA for the transparent overlay; refusing another model avoids interpreting
  // a missing alpha channel as opaque. Page PNGs may be RGB, RGBA or grayscale.
  if (overlay.channels !== 4) throw new Error('annotation raster must contain RGBA pixels');
  const rgba = new Uint8Array(page.width * page.height * 4);
  if (page.channels === 4) rgba.set(page.data);
  else for (let pixel = 0; pixel < page.width * page.height; pixel++) {
    const source = pixel * page.channels, target = pixel * 4;
    rgba[target] = page.data[source];
    rgba[target + 1] = page.channels === 3 ? page.data[source + 1] : page.data[source];
    rgba[target + 2] = page.channels === 3 ? page.data[source + 2] : page.data[source];
    rgba[target + 3] = page.channels === 2 ? page.data[source + 1] : 255;
  }
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const alpha = overlay.data[offset + 3];
    if (!alpha) continue;
    const a = alpha / 255, b = rgba[offset + 3] / 255;
    const outAlpha = a + b * (1 - a);
    for (let channel = 0; channel < 3; channel++) {
      rgba[offset + channel] = Math.round((overlay.data[offset + channel] * a
        + rgba[offset + channel] * b * (1 - a)) / outAlpha);
    }
    rgba[offset + 3] = Math.round(outAlpha * 255);
  }
  return { width: page.width, height: page.height, rgba };
}
