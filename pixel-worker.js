/*
 * FilmWhisper's primary color transform worker.
 *
 * The browser still owns the secondary controls and canvas composition, but
 * the expensive color-managed 32^3 LUT interpolation runs in parallel on a
 * small worker pool. This keeps slider interaction and scrolling responsive
 * while preserving the same math as the main-thread fallback.
 */

"use strict";

const workerState = {
  size: 32,
  matrices: null,
  acr3Forward: null,
};

const ADOBE_RGB_TO_XYZ = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
];

function clamp01(value) { return Math.max(0, Math.min(1, value)); }

function matrixVector(matrix, vector) {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
  ];
}

function srgbDecode(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function srgbEncode(value) {
  const positive = Math.max(0, value);
  return positive <= 0.0031308 ? 12.92 * positive : 1.055 * positive ** (1 / 2.4) - 0.055;
}

function adobeRgbDecode(value) {
  return Math.max(0, value) ** 2.19921875;
}

function inputSettings(colorSpace) {
  const adobe = colorSpace === "adobe-rgb";
  return {
    matrix: adobe ? ADOBE_RGB_TO_XYZ : workerState.matrices.srgbToXyz,
    decode: adobe ? adobeRgbDecode : srgbDecode,
  };
}

function prophotoEncode(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  return sign * (magnitude < 1 / 512 ? magnitude * 16 : magnitude ** (1 / 1.8));
}

function prophotoDecode(value) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  return sign * (magnitude < 16 / 512 ? magnitude / 16 : magnitude ** 1.8);
}

function inverseAcr3Tone(value, inverseTable) {
  if (!inverseTable || inverseTable.length !== 1025) return value;
  const input = clamp01(value);
  let low = 0;
  let high = inverseTable.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (inverseTable[middle] <= input) low = middle;
    else high = middle;
  }
  const span = inverseTable[high] - inverseTable[low];
  const fraction = span > 0 ? (input - inverseTable[low]) / span : 0;
  return (low + fraction) / (inverseTable.length - 1);
}

function buildForwardTable(inverseTable) {
  const table = new Float32Array(4097);
  for (let index = 0; index < table.length; index += 1) {
    table[index] = inverseAcr3Tone(index / (table.length - 1), inverseTable);
  }
  return table;
}

function acr3Forward(value) {
  const table = workerState.acr3Forward;
  if (!table) return value;
  const position = clamp01(value) * (table.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(table.length - 1, lower + 1);
  const fraction = position - lower;
  return table[lower] * (1 - fraction) + table[upper] * fraction;
}

function samplePrimaryLut(lut, red, green, blue) {
  const size = workerState.size;
  const max = size - 1;
  const r = clamp01(red) * max;
  const g = clamp01(green) * max;
  const b = clamp01(blue) * max;
  const r0 = Math.floor(r), g0 = Math.floor(g), b0 = Math.floor(b);
  const r1 = Math.min(max, r0 + 1), g1 = Math.min(max, g0 + 1), b1 = Math.min(max, b0 + 1);
  const rf = r - r0, gf = g - g0, bf = b - b0;
  const index = (ri, gi, bi) => ((ri * size + gi) * size + bi) * 3;
  const values = (ri, gi, bi) => {
    const offset = index(ri, gi, bi);
    return [lut[offset] / 65535, lut[offset + 1] / 65535, lut[offset + 2] / 65535];
  };
  const c000 = values(r0, g0, b0), c001 = values(r0, g0, b1);
  const c010 = values(r0, g1, b0), c011 = values(r0, g1, b1);
  const c100 = values(r1, g0, b0), c101 = values(r1, g0, b1);
  const c110 = values(r1, g1, b0), c111 = values(r1, g1, b1);
  return [0, 1, 2].map((channel) => {
    const c00 = c000[channel] * (1 - bf) + c001[channel] * bf;
    const c01 = c010[channel] * (1 - bf) + c011[channel] * bf;
    const c10 = c100[channel] * (1 - bf) + c101[channel] * bf;
    const c11 = c110[channel] * (1 - bf) + c111[channel] * bf;
    return (c00 * (1 - gf) + c01 * gf) * (1 - rf) + (c10 * (1 - gf) + c11 * gf) * rf;
  });
}

function rgbToHsl(red, green, blue) {
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, saturation, lightness];
}

function hslToRgb(hue, saturation, lightness) {
  if (saturation === 0) return [lightness, lightness, lightness];
  const channel = (n) => {
    const k = (n + hue * 12) % 12;
    return lightness - saturation * Math.min(lightness, 1 - lightness) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function hashNoise(x, y, seed) {
  const value = Math.sin((x * 12.9898 + y * 78.233 + seed * 37.719)) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function processSecondary(source, width, height, values = {}, startRow = 0, fullHeight = height) {
  const secondaryFields = [
    "exposure", "contrast", "highlights", "shadows", "temperature", "tint",
    "saturation", "vibrance", "grain", "bleach", "age", "halation", "vignette", "distortion",
  ];
  const hasSecondaryWork = values.filter !== "无"
    || secondaryFields.some((field) => Math.abs(Number(values[field]) || 0) > 0.0001);
  if (!hasSecondaryWork) return source;

  const output = new Uint8ClampedArray(source);
  const exposure = Math.pow(2, Number(values.exposure) || 0);
  const contrast = 1 + (Number(values.contrast) || 0) / 100;
  const highlight = (Number(values.highlights) || 0) / 100;
  const shadow = (Number(values.shadows) || 0) / 100;
  const temp = (Number(values.temperature) || 0) / 100;
  const tint = (Number(values.tint) || 0) / 100;
  const sat = 1 + (Number(values.saturation) || 0) / 100;
  const vib = (Number(values.vibrance) || 0) / 100;
  const grainAmount = Number(values.grain) / 100;
  const grainSize = Math.max(1, Number(values.grainSize) / 12);
  const grainColor = Number(values.grainColor) / 100;
  const age = Number(values.age) / 50;
  const bleach = Number(values.bleach) / 100;
  const halation = Number(values.halation) / 100;
  const vignette = Number(values.vignette) / 100;
  const distortion = Number(values.distortion) / 100;
  const filter = values.filter;
  const seed = String(values.selectedFilm || "acros-100").length * 17 + 11;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const original = [source[i] / 255, source[i + 1] / 255, source[i + 2] / 255];
      let [red, green, blue] = original;
      red *= exposure; green *= exposure; blue *= exposure;
      red = (red - 0.5) * contrast + 0.5;
      green = (green - 0.5) * contrast + 0.5;
      blue = (blue - 0.5) * contrast + 0.5;
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      const shadowMix = Math.max(0, 0.55 - luminance) / 0.55;
      const highlightMix = Math.max(0, luminance - 0.45) / 0.55;
      red += shadow * shadowMix * 0.18 + highlight * highlightMix * 0.14;
      green += shadow * shadowMix * 0.18 + highlight * highlightMix * 0.14;
      blue += shadow * shadowMix * 0.18 + highlight * highlightMix * 0.14;
      red += temp * 0.11 - tint * 0.035;
      green += tint * 0.08;
      blue -= temp * 0.11 - tint * 0.035;
      if (filter === "Warm 1/8" || filter === "Warm 1/4") {
        const strength = filter === "Warm 1/4" ? 0.055 : 0.028;
        red += strength; green += strength * 0.35; blue -= strength * 0.75;
      } else if (filter === "Black Mist 1/8") {
        const mist = 0.035;
        red = red * (1 - mist) + 0.5 * mist; green = green * (1 - mist) + 0.5 * mist; blue = blue * (1 - mist) + 0.5 * mist;
      } else if (filter === "Glimmer 1/4") {
        red += Math.max(0, luminance - 0.52) * 0.07; green += Math.max(0, luminance - 0.52) * 0.035;
      } else if (filter === "Fog 1/8") {
        red = red * 0.96 + 0.04; green = green * 0.96 + 0.04; blue = blue * 0.96 + 0.04;
      }

      const hsl = rgbToHsl(Math.max(0, red), Math.max(0, green), Math.max(0, blue));
      const vivid = vib >= 0 ? vib * (1 - hsl[1]) : vib;
      [red, green, blue] = hslToRgb(hsl[0], Math.max(0, Math.min(1, hsl[1] * sat + vivid)), hsl[2]);
      const gray = (red + green + blue) / 3;
      red = red * (1 - bleach * 0.52) + gray * bleach * 0.52;
      green = green * (1 - bleach * 0.52) + gray * bleach * 0.52;
      blue = blue * (1 - bleach * 0.52) + gray * bleach * 0.52;
      red = red * (1 - age * 0.12) + age * 0.05;
      green = green * (1 - age * 0.16) + age * 0.035;
      blue = blue * (1 - age * 0.20) + age * 0.015;

      const dx = x / Math.max(1, width - 1) - 0.5;
      const globalY = startRow + y;
      const dy = globalY / Math.max(1, fullHeight - 1) - 0.5;
      const edge = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.45);
      const vignetteFactor = 1 - vignette * edge * edge * 0.65;
      red *= vignetteFactor; green *= vignetteFactor; blue *= vignetteFactor;
      if (distortion !== 0) {
        const warp = distortion * edge * edge * 0.045;
        red += warp * 0.7; green += warp * 0.3; blue -= warp * 0.4;
      }
      if (halation > 0 && luminance > 0.64) {
        const glow = ((luminance - 0.64) / 0.36) * halation * 0.24;
        red += glow * 1.25; green += glow * 0.18; blue -= glow * 0.15;
      }
      if (grainAmount > 0) {
        const gx = Math.floor(x / grainSize) * grainSize;
        const gy = Math.floor(globalY / grainSize) * grainSize;
        const noise = hashNoise(gx, gy, seed);
        const strength = grainAmount * (0.045 + Number(values.grainSize) / 100 * 0.055);
        red += noise * strength;
        green += noise * strength * (0.84 + grainColor * 0.12);
        blue += noise * strength * (0.72 + grainColor * 0.24);
      }
      output[i] = Math.max(0, Math.min(255, Math.round(red * 255)));
      output[i + 1] = Math.max(0, Math.min(255, Math.round(green * 255)));
      output[i + 2] = Math.max(0, Math.min(255, Math.round(blue * 255)));
    }
  }
  return output;
}

function renderChunk(source, lutBuffer, amount, width, height, fullHeight, startRow, values, colorSpace, applyAcr3) {
  const lut = new Uint16Array(lutBuffer);
  const output = new Uint8ClampedArray(source);
  const matrices = workerState.matrices;
  if (!matrices?.srgbToXyz) return output;
  const input = inputSettings(colorSpace);
  const mix = clamp01(amount);
  for (let index = 0; index < source.length; index += 4) {
    const original = [source[index] / 255, source[index + 1] / 255, source[index + 2] / 255];
    const linearInput = original.map(input.decode);
    const xyzD65 = matrixVector(input.matrix, linearInput);
    const xyzD50 = matrixVector(matrices.d65ToD50, xyzD65);
    const proLinear = matrixVector(matrices.xyzToProphoto, xyzD50);
    const proEncoded = proLinear.map((value) => clamp01(prophotoEncode(applyAcr3 ? acr3Forward(value) : value)));
    const mappedPro = samplePrimaryLut(lut, proEncoded[0], proEncoded[1], proEncoded[2]);
    const mappedProLinear = mappedPro.map(prophotoDecode);
    const mappedXyzD50 = matrixVector(matrices.prophotoToXyz, mappedProLinear);
    const mappedXyzD65 = matrixVector(matrices.d50ToD65, mappedXyzD50);
    const mappedLinearSrgb = matrixVector(matrices.xyzToSrgb, mappedXyzD65).map(clamp01);
    const mapped = mappedLinearSrgb.map(srgbEncode);
    output[index] = Math.round((original[0] * (1 - mix) + mapped[0] * mix) * 255);
    output[index + 1] = Math.round((original[1] * (1 - mix) + mapped[1] * mix) * 255);
    output[index + 2] = Math.round((original[2] * (1 - mix) + mapped[2] * mix) * 255);
  }
  return processSecondary(output, width, height, values, startRow, fullHeight);
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    workerState.size = message.size || 32;
    workerState.matrices = message.matrices || null;
    workerState.acr3Forward = buildForwardTable(message.acr3Inverse || []);
    return;
  }
  if (message.type !== "render") return;
  try {
    const result = renderChunk(new Uint8ClampedArray(message.buffer), message.lutBuffer, message.amount, message.width, message.height, message.fullHeight, message.startRow, message.values, message.colorSpace, message.applyAcr3);
    self.postMessage({ id: message.id, startRow: message.startRow, buffer: result.buffer }, [result.buffer]);
  } catch (error) {
    self.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
