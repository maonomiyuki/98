const OUT_W = 640;
const OUT_H = 400;
const CROP_RATIO = 8 / 5;
const BAYER_8X8 = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21]
];

const state = {
  colorCount: 16,
  paletteMode: 'graphic',
  dither: 'ordered',
  orderedStrength: 10,
  gammaOffset: 0,
  saturation: -10,
  contrast: 1,
  sharpness: 0.12,
  exportScale: 1,
  scale1x: false,
  source: null,
  crop: { x: 0, y: 0, zoom: 1 }
};

const el = {
  controls: document.getElementById('controls'),
  sourceCanvas: document.getElementById('sourceCanvas'),
  outCanvas: document.getElementById('outCanvas')
};
const sourceCtx = el.sourceCanvas.getContext('2d');
const outCtx = el.outCanvas.getContext('2d');
let drag = null;

const to4bit = (v8) => Math.max(0, Math.min(15, Math.round(v8 / 17)));
const to8bit = (v4) => v4 * 17;
const packId = (r4, g4, b4) => (r4 << 8) | (g4 << 4) | b4;
const clamp4 = (v) => Math.max(0, Math.min(15, v));

function unpackId(id) {
  const r4 = (id >> 8) & 15;
  const g4 = (id >> 4) & 15;
  const b4 = id & 15;
  return { r: to8bit(r4), g: to8bit(g4), b: to8bit(b4), r4, g4, b4, id };
}

function weightedDist(a, b) {
  const dr = a.r4 - b.r4;
  const dg = a.g4 - b.g4;
  const db = a.b4 - b.b4;
  return (2 * dr) ** 2 + (4 * dg) ** 2 + db ** 2;
}

function nearestPaletteColor(px, palette) {
  let best = palette[0];
  let bestD = Infinity;
  for (const p of palette) {
    const d = weightedDist(px, p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function buildHistogram(data) {
  const hist = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const id = packId(to4bit(data[i]), to4bit(data[i + 1]), to4bit(data[i + 2]));
    hist.set(id, (hist.get(id) ?? 0) + 1);
  }
  return hist;
}

function brightnessBucket(c) {
  const y = 0.2126 * c.r4 + 0.7152 * c.g4 + 0.0722 * c.b4;
  if (y < 5) return 'dark';
  if (y < 10) return 'mid';
  return 'light';
}

function selectGraphicPalette(hist, targetSize, minDist = 10) {
  const alpha = 0.75;
  const edgeWeight = 0.8;
  const items = [...hist.entries()].map(([id, count]) => ({ ...unpackId(id), count }));
  const score = (item) => {
    const freq = Math.pow(item.count, alpha);
    let local = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        for (let db = -1; db <= 1; db++) {
          if (!dr && !dg && !db) continue;
          const rr = item.r4 + dr;
          const gg = item.g4 + dg;
          const bb = item.b4 + db;
          if (rr < 0 || rr > 15 || gg < 0 || gg > 15 || bb < 0 || bb > 15) continue;
          const n = hist.get(packId(rr, gg, bb)) ?? 0;
          local += 1 / (1 + n);
        }
      }
    }
    return freq + edgeWeight * local;
  };

  items.sort((a, b) => score(b) - score(a));
  const selected = [];
  const buckets = { dark: 0, mid: 0, light: 0 };

  for (const item of items) {
    if (selected.length >= targetSize) break;
    if (selected.some((s) => weightedDist(s, item) < minDist)) continue;
    const b = brightnessBucket(item);
    const maxPerBucket = Math.ceil(targetSize / 2);
    if (buckets[b] >= maxPerBucket) continue;
    selected.push(item);
    buckets[b] += 1;
  }

  for (const item of items) {
    if (selected.length >= targetSize) break;
    if (selected.some((s) => s.id === item.id)) continue;
    selected.push(item);
  }
  return selected.slice(0, targetSize);
}

function selectGamePalette(hist, targetSize, minDist = 14) {
  const items = [...hist.entries()]
    .map(([id, count]) => ({ ...unpackId(id), count }))
    .sort((a, b) => b.count - a.count);

  const baseTarget = targetSize === 8 ? 4 : 8;
  const selected = [];
  for (const item of items) {
    if (selected.length >= baseTarget) break;
    if (selected.some((s) => weightedDist(s, item) < minDist)) continue;
    selected.push(item);
  }

  const byLum = [...items].sort((a, b) => a.r4 + a.g4 + a.b4 - (b.r4 + b.g4 + b.b4));
  const add = (c) => c && !selected.some((s) => s.id === c.id) && selected.push(c);
  add(byLum[0]);
  add(byLum.at(-1));
  items
    .filter((c) => Math.abs(c.r4 - c.g4) <= 1 && Math.abs(c.g4 - c.b4) <= 1)
    .slice(0, targetSize === 8 ? 1 : 2)
    .forEach(add);

  for (const c of [...selected]) {
    if (selected.length >= targetSize) break;
    const shade = unpackId(packId(clamp4(c.r4 - 1), clamp4(c.g4 - 1), clamp4(c.b4 - 1)));
    const light = unpackId(packId(clamp4(c.r4 + 1), clamp4(c.g4 + 1), clamp4(c.b4 + 1)));
    add(hist.has(shade.id) ? shade : shade);
    if (selected.length >= targetSize) break;
    add(hist.has(light.id) ? light : light);
  }

  for (const item of items) {
    if (selected.length >= targetSize) break;
    add(item);
  }
  return selected.slice(0, targetSize);
}

function gammaFromOffset(gammaOffset) {
  const gammaOffsetNorm = gammaOffset / 100;
  return Math.pow(2, -gammaOffsetNorm);
}

function applyPreAdjustments(r, g, b) {
  const sat = state.saturation / 100;
  const gamma = gammaFromOffset(state.gammaOffset);
  let rr = r / 255;
  let gg = g / 255;
  let bb = b / 255;
  const lum = rr * 0.299 + gg * 0.587 + bb * 0.114;
  rr = lum + (rr - lum) * (1 + sat);
  gg = lum + (gg - lum) * (1 + sat);
  bb = lum + (bb - lum) * (1 + sat);

  rr = (rr - 0.5) * state.contrast + 0.5;
  gg = (gg - 0.5) * state.contrast + 0.5;
  bb = (bb - 0.5) * state.contrast + 0.5;

  rr = Math.pow(Math.max(0, Math.min(1, rr)), 1 / gamma);
  gg = Math.pow(Math.max(0, Math.min(1, gg)), 1 / gamma);
  bb = Math.pow(Math.max(0, Math.min(1, bb)), 1 / gamma);

  return [Math.round(rr * 255), Math.round(gg * 255), Math.round(bb * 255)];
}

function applySharpenOnImageData(imageData, amount) {
  if (amount <= 0) return;
  const src = new Uint8ClampedArray(imageData.data);
  const out = imageData.data;
  for (let y = 1; y < OUT_H - 1; y++) {
    for (let x = 1; x < OUT_W - 1; x++) {
      const i = (y * OUT_W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = src[i + c];
        const n = src[i - OUT_W * 4 + c];
        const s = src[i + OUT_W * 4 + c];
        const e = src[i + 4 + c];
        const w = src[i - 4 + c];
        const edge = center * 5 - n - s - e - w;
        out[i + c] = Math.max(0, Math.min(255, center + (edge - center) * amount));
      }
    }
  }
}

function lumaFromRgb8(r, g, b) {
  return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
}

function applyDarkDesaturation(r, g, b) {
  const luma = lumaFromRgb8(r, g, b);
  if (luma >= 0.35) return [r, g, b];

  const t = 1 - luma / 0.35;
  const mixAmount = 0.7 + 0.3 * t;
  const gray = luma * 255;
  const rr = r * (1 - mixAmount) + gray * mixAmount;
  const gg = g * (1 - mixAmount) + gray * mixAmount;
  const bb = b * (1 - mixAmount) + gray * mixAmount;
  return [rr, gg, bb];
}

function pickLineSnapColor(palette) {
  let best = palette[0];
  let bestScore = Infinity;
  for (const c of palette) {
    const luma = 0.2126 * c.r4 + 0.7152 * c.g4 + 0.0722 * c.b4;
    const chroma = Math.abs(c.r4 - c.g4) + Math.abs(c.g4 - c.b4) + Math.abs(c.b4 - c.r4);
    const blueBias = c.b4 > c.r4 && c.b4 >= c.g4 ? -0.3 : 0;
    const score = luma * 2 + chroma * 1.1 + blueBias;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function renderControls() {
  el.controls.innerHTML = `
    <label>画像読み込み<input type="file" id="file" accept="image/*"></label>
    <label>色数
      <select id="colorCount"><option value="8">8</option><option value="16">16</option></select>
    </label>
    <label>パレット選択
      <select id="paletteMode"><option value="graphic">グラフィックモード</option><option value="game">ゲームモード</option></select>
    </label>
    <label>ディザ方式
      <select id="dither"><option value="off">OFF</option><option value="ordered">Ordered (Bayer 8x8)</option><option value="floyd">Floyd-Steinberg</option></select>
    </label>
    <label>Ordered強度 <span id="orderedStrengthLabel"></span>
      <input type="range" id="orderedStrength" min="0" max="100" />
    </label>
    <label>Gamma Offset <span id="gammaOffsetLabel"></span>
      <input type="range" id="gammaOffset" min="-100" max="100" step="1" />
    </label>
    <label>Saturation <span id="saturationLabel"></span>
      <input type="range" id="saturation" min="-30" max="10" />
    </label>
    <label>Contrast <span id="contrastLabel"></span>
      <input type="range" id="contrast" min="0.8" max="1.2" step="0.01" />
    </label>
    <label>Sharpness <span id="sharpnessLabel"></span>
      <input type="range" id="sharpness" min="0" max="0.5" step="0.01" />
    </label>
    <label>書き出し倍率
      <select id="exportScale"><option value="1">x1</option><option value="2">x2</option><option value="3">x3</option><option value="4">x4</option></select>
    </label>
    <div class="row"><button id="scale">${state.scale1x ? '表示:fit' : '表示:1x'}</button><button id="download">PNGダウンロード</button></div>
  `;

  const bind = (id, handler) => {
    const node = document.getElementById(id);
    if (node) node.addEventListener('input', handler);
    return node;
  };

  bind('file', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.source = img;
      state.crop = { x: 0, y: 0, zoom: 1 };
      URL.revokeObjectURL(url);
      render();
    };
    img.src = url;
  });

  document.getElementById('scale').addEventListener('click', () => {
    state.scale1x = !state.scale1x;
    el.outCanvas.classList.toggle('oneX', state.scale1x);
    renderControls();
  });

  document.getElementById('download').addEventListener('click', () => {
    const scale = state.exportScale;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = OUT_W * scale;
    exportCanvas.height = OUT_H * scale;
    const exportCtx = exportCanvas.getContext('2d');
    if (!exportCtx) return;
    exportCtx.imageSmoothingEnabled = false;
    exportCtx.drawImage(el.outCanvas, 0, 0, exportCanvas.width, exportCanvas.height);

    const a = document.createElement('a');
    a.href = exportCanvas.toDataURL('image/png');
    a.download = `pc98_${OUT_W}x${OUT_H}@${scale}x.png`;
    a.click();
  });

  const map = [
    ['colorCount', Number],
    ['paletteMode', (v) => v],
    ['dither', (v) => v],
    ['orderedStrength', Number],
    ['gammaOffset', Number],
    ['saturation', Number],
    ['contrast', Number],
    ['sharpness', Number],
    ['exportScale', Number]
  ];

  map.forEach(([k, cast]) => {
    const node = document.getElementById(k);
    node.value = state[k];
    node.addEventListener('input', (e) => {
      if (k === 'paletteMode') applyPreset(e.target.value);
      else state[k] = cast(e.target.value);
      renderControls();
      render();
    });
  });

  document.getElementById('orderedStrengthLabel').textContent = state.orderedStrength;
  document.getElementById('gammaOffsetLabel').textContent = `${state.gammaOffset > 0 ? '+' : ''}${state.gammaOffset}`;
  document.getElementById('saturationLabel').textContent = `${state.saturation}%`;
  document.getElementById('contrastLabel').textContent = state.contrast.toFixed(2);
  document.getElementById('sharpnessLabel').textContent = state.sharpness.toFixed(2);
}

function applyPreset(mode) {
  if (mode === 'graphic') {
    Object.assign(state, {
      paletteMode: 'graphic',
      dither: 'ordered',
      orderedStrength: 10,
      gammaOffset: 0,
      saturation: -10,
      contrast: 1,
      sharpness: 0.08
    });
  } else {
    Object.assign(state, {
      paletteMode: 'game',
      dither: 'off',
      gammaOffset: 0,
      saturation: -5,
      contrast: 1.08,
      sharpness: 0.18
    });
  }
}

function renderSource() {
  sourceCtx.clearRect(0, 0, OUT_W, OUT_H);
  if (!state.source) return;

  const baseW = state.source.width;
  const baseH = state.source.height;
  const srcAspect = baseW / baseH;
  let cw;
  let ch;
  if (srcAspect > CROP_RATIO) {
    ch = baseH / state.crop.zoom;
    cw = ch * CROP_RATIO;
  } else {
    cw = baseW / state.crop.zoom;
    ch = cw / CROP_RATIO;
  }

  const x = Math.max(0, Math.min(baseW - cw, (baseW - cw) / 2 + state.crop.x));
  const y = Math.max(0, Math.min(baseH - ch, (baseH - ch) / 2 + state.crop.y));
  sourceCtx.imageSmoothingQuality = 'high';
  sourceCtx.drawImage(state.source, x, y, cw, ch, 0, 0, OUT_W, OUT_H);
}

function renderOutput() {
  if (!state.source) return;
  const src = sourceCtx.getImageData(0, 0, OUT_W, OUT_H);
  const base = new Uint8ClampedArray(src.data);

  for (let i = 0; i < base.length; i += 4) {
    const [rr, gg, bb] = applyPreAdjustments(base[i], base[i + 1], base[i + 2]);
    base[i] = rr;
    base[i + 1] = gg;
    base[i + 2] = bb;
  }

  const hist = buildHistogram(base);
  const palette = state.paletteMode === 'graphic' ? selectGraphicPalette(hist, state.colorCount) : selectGamePalette(hist, state.colorCount);
  const lineSnapColor = pickLineSnapColor(palette);
  const work = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) work[i] = base[i];

  const lumaMap = new Float32Array(OUT_W * OUT_H);
  for (let y = 0; y < OUT_H; y++) {
    for (let x = 0; x < OUT_W; x++) {
      const i = (y * OUT_W + x) * 4;
      lumaMap[y * OUT_W + x] = lumaFromRgb8(base[i], base[i + 1], base[i + 2]);
    }
  }

  const lineMask = new Uint8Array(OUT_W * OUT_H);
  for (let y = 1; y < OUT_H - 1; y++) {
    for (let x = 1; x < OUT_W - 1; x++) {
      const idx = y * OUT_W + x;
      const center = lumaMap[idx];
      if (center >= 0.22) continue;
      let sum = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          sum += lumaMap[(y + oy) * OUT_W + (x + ox)];
        }
      }
      const localContrast = Math.abs(center - sum / 8);
      if (localContrast > 0.075) {
        lineMask[idx] = 1;
      }
    }
  }

  for (let y = 0; y < OUT_H; y++) {
    for (let x = 0; x < OUT_W; x++) {
      const i = (y * OUT_W + x) * 4;
      const idx = y * OUT_W + x;
      let r = work[i];
      let g = work[i + 1];
      let b = work[i + 2];
      const isLine = lineMask[idx] === 1;

      if (state.dither === 'ordered' && !isLine) {
        const bayer = BAYER_8X8[y % 8][x % 8] / 63 - 0.5;
        const strength = (state.orderedStrength / 100) * 12;
        const lumBias = bayer * strength;
        r += lumBias;
        g += lumBias;
        b += lumBias;
      }

      [r, g, b] = applyDarkDesaturation(r, g, b);

      if (isLine) {
        r = lineSnapColor.r;
        g = lineSnapColor.g;
        b = lineSnapColor.b;
      }

      const q = nearestPaletteColor({ r4: to4bit(r), g4: to4bit(g), b4: to4bit(b) }, palette);
      const qr = to8bit(to4bit(q.r));
      const qg = to8bit(to4bit(q.g));
      const qb = to8bit(to4bit(q.b));

      if (state.dither === 'floyd') {
        const er = r - qr;
        const eg = g - qg;
        const eb = b - qb;
        const spread = (xx, yy, k) => {
          if (xx < 0 || yy < 0 || xx >= OUT_W || yy >= OUT_H) return;
          const j = (yy * OUT_W + xx) * 4;
          work[j] += er * k;
          work[j + 1] += eg * k;
          work[j + 2] += eb * k;
        };
        spread(x + 1, y, 7 / 16);
        spread(x - 1, y + 1, 3 / 16);
        spread(x, y + 1, 5 / 16);
        spread(x + 1, y + 1, 1 / 16);
      }

      src.data[i] = qr;
      src.data[i + 1] = qg;
      src.data[i + 2] = qb;
      src.data[i + 3] = 255;
    }
  }

  applySharpenOnImageData(src, state.sharpness);

  outCtx.putImageData(src, 0, 0);
}

function render() {
  renderSource();
  renderOutput();
}

el.sourceCanvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, ox: state.crop.x, oy: state.crop.y };
});

el.sourceCanvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  state.crop.x = drag.ox - dx * state.crop.zoom;
  state.crop.y = drag.oy - dy * state.crop.zoom;
  render();
});

['pointerup', 'pointerleave', 'pointercancel'].forEach((evt) => {
  el.sourceCanvas.addEventListener(evt, () => {
    drag = null;
  });
});

el.sourceCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.crop.zoom = Math.max(1, Math.min(6, state.crop.zoom * (e.deltaY > 0 ? 0.95 : 1.05)));
  render();
});

renderControls();
