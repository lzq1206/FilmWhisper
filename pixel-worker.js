/*
 * FilmWhisper's primary color transform worker.
 *
 * The browser still owns the secondary controls and canvas composition, but
 * the expensive color-managed 32^3 LUT interpolation runs in parallel on a
 * small worker pool. This keeps slider interaction and scrolling responsive
 * while preserving the same math as the main-thread fallback.
 */

"use strict";
importScripts("curves.js?v=20261001-curves");

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
const DISPLAY_P3_TO_XYZ = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];
const REC2020_TO_XYZ = [
  [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0, 0.028072693049087428, 1.060985057710791],
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

function rec2020Decode(value) {
  const positive = Math.max(0, value);
  const alpha = 1.09929682680944;
  const beta = 0.018053968510807;
  return positive < beta * 4.5
    ? positive / 4.5
    : ((positive + 1 - alpha) / alpha) ** (1 / 0.45);
}

function inputSettings(colorSpace) {
  const profiles = {
    "adobe-rgb": { matrix: ADOBE_RGB_TO_XYZ, decode: adobeRgbDecode, white: "d65" },
    "display-p3": { matrix: DISPLAY_P3_TO_XYZ, decode: srgbDecode, white: "d65" },
    "prophoto-rgb": { matrix: workerState.matrices.prophotoToXyz, decode: prophotoDecode, white: "d50" },
    rec2020: { matrix: REC2020_TO_XYZ, decode: rec2020Decode, white: "d65" },
    srgb: { matrix: workerState.matrices.srgbToXyz, decode: srgbDecode, white: "d65" },
  };
  return profiles[colorSpace] || profiles.srgb;
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
    "saturation", "vibrance", "grain", "bleach", "age", "halation", "halationReturn", "haloHue", "vignette", "distortion",
    "push", "screenExposure", "printerPreflash",
  ];
  const hasSecondaryWork = values.filter !== "无"
    || secondaryFields.some((field) => Math.abs(Number(values[field]) || 0) > 0.0001)
    || values.paperGrade !== "Reference"
    || values.enlarger !== "Diffuser"
    || values.negativeViewing !== "Reference Exposure"
    || values.outputMedium !== "Photo"
    || values.viewingIlluminant !== "D50";
  if (!hasSecondaryWork) return FilmCurves.apply(source, values.curves);

  const output = new Uint8ClampedArray(source);
  const formatScale = ({ "35mm": 1, "120": 0.72, "4×5": 0.48, "Instax Mini": 1.3, "Instax Square": 1.16, "Instax Wide": 1.02, "Super 8": 1.55 })[values.filmFormat] || 1;
  const exposure = Math.pow(2, (Number(values.exposure) || 0) + (Number(values.push) || 0) * 0.32 + (Number(values.screenExposure) || 0)
    + (values.negativeViewing === "Auto Levels" ? 0.08 : 0));
  const contrast = (1 + (Number(values.contrast) || 0) / 100)
    * (values.paperGrade === "Hard" ? 1.08 : values.paperGrade === "Soft" ? 0.92 : 1)
    * (values.enlarger === "Condenser" ? 1.04 : values.enlarger === "Diffuser" ? 0.97 : 1)
    * (values.negativeViewing === "Graded Print" ? 1.06 : values.negativeViewing === "Auto Levels" ? 0.98 : 1)
    * (values.outputMedium === "Print" ? 1.04 : values.outputMedium === "Screen" ? 0.98 : 1);
  const highlight = (Number(values.highlights) || 0) / 100;
  const shadow = (Number(values.shadows) || 0) / 100;
  const temp = (Number(values.temperature) || 0) / 100
    + (values.viewingIlluminant === "Tungsten 2856 K" ? -0.12 : values.viewingIlluminant === "Daylight 5500 K" ? 0.03 : 0);
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
      if (Number(values.printerPreflash) > 0) {
        const preflash = Math.min(1, Number(values.printerPreflash) / 100) * Math.max(0, 1 - luminance) * 0.12;
        red += preflash; green += preflash; blue += preflash;
      }

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
        const glow = ((luminance - 0.64) / 0.36) * halation * (0.12 + Number(values.halationReturn || 25) / 100 * 0.24) * formatScale;
        const halo = hslToRgb(Math.max(0, Number(values.haloHue) || 12) / 360, 0.72, 0.52);
        red += glow * halo[0]; green += glow * halo[1]; blue += glow * halo[2];
      }
      if (grainAmount > 0) {
        const gx = Math.floor(x / grainSize) * grainSize;
        const gy = Math.floor(globalY / grainSize) * grainSize;
        const noise = hashNoise(gx, gy, seed);
        const strength = grainAmount * formatScale * (0.045 + Number(values.grainSize) / 100 * 0.055);
        red += noise * strength;
        green += noise * strength * (0.84 + grainColor * 0.12);
        blue += noise * strength * (0.72 + grainColor * 0.24);
      }
      output[i] = Math.max(0, Math.min(255, Math.round(red * 255)));
      output[i + 1] = Math.max(0, Math.min(255, Math.round(green * 255)));
      output[i + 2] = Math.max(0, Math.min(255, Math.round(blue * 255)));
    }
  }
  return FilmCurves.apply(output, values.curves);
}

function sampleFilmTransform(lut, adapter, encoded) {
  const acrEncoded = adapter ? samplePrimaryLut(adapter, ...encoded) : encoded;
  return samplePrimaryLut(lut, ...acrEncoded);
}

function renderChunk(source, lutBuffer, amount, width, height, fullHeight, startRow, values, colorSpace, applyAcr3, adapter) {
  const lut = new Uint16Array(lutBuffer);
  const output = new Uint8ClampedArray(source);
  const matrices = workerState.matrices;
  if (!matrices?.srgbToXyz) return output;
  const input = inputSettings(colorSpace);
  const mix = clamp01(amount);
  for (let index = 0; index < source.length; index += 4) {
    const original = [source[index] / 255, source[index + 1] / 255, source[index + 2] / 255];
    const linearInput = original.map(input.decode);
    const xyzD65 = input.white === "d50"
      ? matrixVector(matrices.d50ToD65, matrixVector(input.matrix, linearInput))
      : matrixVector(input.matrix, linearInput);
    const xyzD50 = matrixVector(matrices.d65ToD50, xyzD65);
    const proLinear = matrixVector(matrices.xyzToProphoto, xyzD50);
    const proEncoded = proLinear.map((value) => clamp01(prophotoEncode(applyAcr3 ? acr3Forward(value) : value)));
    const mappedPro = sampleFilmTransform(lut, adapter, proEncoded);
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

// LibRaw emits camera-corrected scene-linear Rec.2020 samples as uint16.  Keep
// those samples at 16-bit through the gamut conversion and LUT lookup; only the
// final display/export representation is quantised at the very end.
function renderRaw16Chunk(source, lutBuffer, amount, width, height, fullHeight, startRow, values, applyAcr3, outputType, adapter) {
  const lut = new Uint16Array(lutBuffer);
  const matrices = workerState.matrices;
  const output = outputType === "rgba16"
    ? new Uint16Array(width * height * 4)
    : new Uint8ClampedArray(width * height * 4);
  if (!matrices?.srgbToXyz) return output;
  const mix = clamp01(amount);
  const scale = outputType === "rgba16" ? 65535 : 255;
  const sceneScale = Number(values?.rawSceneScale);
  const sceneFactor = Number.isFinite(sceneScale) && sceneScale > 0 ? sceneScale : 1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceIndex = pixel * 3;
    const original = [source[sourceIndex] * sceneFactor / 65535, source[sourceIndex + 1] * sceneFactor / 65535, source[sourceIndex + 2] * sceneFactor / 65535];
    const xyzD65 = matrixVector(REC2020_TO_XYZ, original);
    const xyzD50 = matrixVector(matrices.d65ToD50, xyzD65);
    const proLinear = matrixVector(matrices.xyzToProphoto, xyzD50);
    const proEncoded = proLinear.map((value) => clamp01(prophotoEncode(applyAcr3 ? acr3Forward(value) : value)));
    const mappedPro = sampleFilmTransform(lut, adapter, proEncoded);
    const mappedXyzD50 = matrixVector(matrices.prophotoToXyz, mappedPro.map(prophotoDecode));
    const mappedXyzD65 = matrixVector(matrices.d50ToD65, mappedXyzD50);
    const mappedLinearSrgb = matrixVector(matrices.xyzToSrgb, mappedXyzD65).map(clamp01);
    const baseLinearSrgb = matrixVector(matrices.xyzToSrgb, xyzD65).map(clamp01);
    const base = baseLinearSrgb.map(srgbEncode);
    const mapped = mappedLinearSrgb.map(srgbEncode);
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const outputIndex = pixel * 4;
    const valuesOut = [0, 1, 2].map((channel) => Math.max(0, Math.min(1, base[channel] * (1 - mix) + mapped[channel] * mix)));
    if (outputType === "rgba16") {
      output[outputIndex] = Math.round(valuesOut[0] * scale);
      output[outputIndex + 1] = Math.round(valuesOut[1] * scale);
      output[outputIndex + 2] = Math.round(valuesOut[2] * scale);
      output[outputIndex + 3] = 65535;
    } else {
      output[outputIndex] = Math.round(valuesOut[0] * scale);
      output[outputIndex + 1] = Math.round(valuesOut[1] * scale);
      output[outputIndex + 2] = Math.round(valuesOut[2] * scale);
      output[outputIndex + 3] = 255;
    }
    // Secondary controls operate in the display encoding. For 16-bit export,
    // leave the result at 16-bit and apply the same arithmetic in place below.
    void x; void y;
  }
  if (outputType === "rgba8") return processSecondary(output, width, height, values, startRow, fullHeight);
  return FilmCurves.apply(output, values.curves);
}

function renderRgba16Chunk(source, lutBuffer, amount, width, height, fullHeight, startRow, values, colorSpace, applyAcr3, outputType, adapter) {
  const lut = new Uint16Array(lutBuffer);
  const matrices = workerState.matrices;
  const input = inputSettings(colorSpace);
  const output = outputType === "rgba16"
    ? new Uint16Array(width * height * 4)
    : new Uint8ClampedArray(width * height * 4);
  if (!matrices?.srgbToXyz) return output;
  const mix = clamp01(amount);
  const scale = outputType === "rgba16" ? 65535 : 255;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const si = pixel * 4;
    const original = [source[si] / 65535, source[si + 1] / 65535, source[si + 2] / 65535];
    const linearInput = original.map(input.decode);
    const xyzD65 = input.white === "d50"
      ? matrixVector(matrices.d50ToD65, matrixVector(input.matrix, linearInput))
      : matrixVector(input.matrix, linearInput);
    const xyzD50 = matrixVector(matrices.d65ToD50, xyzD65);
    const proLinear = matrixVector(matrices.xyzToProphoto, xyzD50);
    const proEncoded = proLinear.map((value) => clamp01(prophotoEncode(applyAcr3 ? acr3Forward(value) : value)));
    const mappedPro = sampleFilmTransform(lut, adapter, proEncoded);
    const mappedXyzD65 = matrixVector(matrices.d50ToD65, matrixVector(matrices.prophotoToXyz, mappedPro.map(prophotoDecode)));
    const mapped = matrixVector(matrices.xyzToSrgb, mappedXyzD65).map(clamp01).map(srgbEncode);
    const base = matrixVector(matrices.xyzToSrgb, xyzD65).map(clamp01).map(srgbEncode);
    const oi = pixel * 4;
    const valuesOut = [0, 1, 2].map((channel) => Math.max(0, Math.min(1, base[channel] * (1 - mix) + mapped[channel] * mix)));
    output[oi] = Math.round(valuesOut[0] * scale);
    output[oi + 1] = Math.round(valuesOut[1] * scale);
    output[oi + 2] = Math.round(valuesOut[2] * scale);
    output[oi + 3] = scale;
  }
  if (outputType === "rgba8") return processSecondary(output, width, height, values, startRow, fullHeight);
  return FilmCurves.apply(output, values.curves);
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
    const adapter = message.adapterBuffer ? new Uint16Array(message.adapterBuffer) : null;
    const result = message.sourceType === "raw16"
      ? renderRaw16Chunk(new Uint16Array(message.buffer), message.lutBuffer, message.amount, message.width, message.height, message.fullHeight, message.startRow, message.values, message.applyAcr3, message.outputType || "rgba8", adapter)
      : message.sourceType === "rgba16"
        ? renderRgba16Chunk(new Uint16Array(message.buffer), message.lutBuffer, message.amount, message.width, message.height, message.fullHeight, message.startRow, message.values, message.colorSpace, message.applyAcr3, message.outputType || "rgba8", adapter)
      : renderChunk(new Uint8ClampedArray(message.buffer), message.lutBuffer, message.amount, message.width, message.height, message.fullHeight, message.startRow, message.values, message.colorSpace, message.applyAcr3, adapter);
    self.postMessage({ id: message.id, startRow: message.startRow, buffer: result.buffer }, [result.buffer]);
  } catch (error) {
    self.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
