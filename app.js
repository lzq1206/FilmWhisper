(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const shell = $("#appShell");
  const stage = $("#canvasStage");
  const canvas = $("#previewCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const fileInput = $("#fileInput");
  const emptyState = $("#emptyState");
  const filmGrid = $("#filmGrid");
  const historyList = $("#historyList");
  const savedList = $("#savedList");
  const filmSearch = $("#filmSearch");
  const activeFilmLabel = $("#activeFilmLabel");
  const favoriteButton = $('[data-action="favorite"]');
  const renderStatus = $("#renderStatus");
  const zoomLabel = $("#zoomLabel");
  const stageToast = $("#stageToast");
  const compareLine = $("#compareLine");
  const cropOverlay = $("#cropOverlay");
  const cropSelection = $("#cropSelection");
  const modePanelEyebrow = $("#modePanelEyebrow");
  const modePanelTitle = $("#modePanelTitle");
  const mobileBottomNav = $("#mobileBottomNav");
  const histogramBars = $$(".mini-histogram i");

  const defaultValues = {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    vibrance: 0,
    filmAmount: 100,
    push: 0,
    bleach: 0,
    age: 0,
    grain: 0,
    grainSize: 35,
    grainColor: 50,
    halation: 0,
    halationReturn: 25,
    haloHue: 12,
    vignette: 0,
    distortion: 0,
    frameSize: 0,
    straighten: 0,
    negativeViewing: "Reference Exposure",
    viewingIlluminant: "D50",
    paperGrade: "Reference",
    screenExposure: 0,
    enlarger: "Diffuser",
    printerPreflash: 0,
    aspect: "free",
    filmFormat: "35mm",
    filter: "无",
    frameStyle: "black",
    outputFormat: "image/jpeg",
    quality: 92,
    outputMedium: "Photo",
  };

  const filmPresets = (Array.isArray(window.FILM_PROFILES) && window.FILM_PROFILES.length
    ? window.FILM_PROFILES
    : [{ id: "acros-100", name: "ACROS 100", meta: "色彩配置", swatch: "linear-gradient(135deg,#20242b,#8b6a58 48%,#d9b083)", index: 0 }])
    .map((profile) => ({ ...profile, values: {} }));
  const defaultFilmId = filmPresets[0]?.id || "acros-100";

  function readSavedFilms() {
    try {
      const value = JSON.parse(localStorage.getItem("filmwhisper-saved") || "[]");
      return Array.isArray(value) ? value.filter((id) => filmPresets.some((film) => film.id === id)) : [];
    } catch {
      return [];
    }
  }

  const state = {
    ...defaultValues,
    selectedFilm: defaultFilmId,
    mode: "develop",
    mobileNav: "develop",
    cropRect: null,
    zoom: 1,
    before: false,
    compare: false,
    rotation: 0,
    flipH: false,
    image: null,
    imageUrl: "",
    imageLoaded: false,
    imageLabel: "",
    // Browser images are already rendered/output-referred. Keep the source
    // primaries when possible so an Adobe RGB JPEG is not gamut-compressed to
    // sRGB before it reaches the XMP LUT.
    imageColorSpace: "srgb",
    imageApplyAcr3: false,
    rawImage: null,
    deepImage: null,
    imageBitDepth: 8,
    imageName: "",
    history: [],
    historyIndex: -1,
    savedFilms: readSavedFilms(),
  };

  let renderToken = 0;
  let imageLoadToken = 0;
  let toastTimer;
  let compareCanvas = null;
  let cropPointer = null;
  let lastCanvasSize = { width: 0, height: 0 };
  const lutConfig = window.FILM_LUT_CONFIG || null;
  const lutState = {
    buffer: null,
    renderedBuffer: null,
    rawBuffer: null,
    size: lutConfig?.size || 32,
    count: lutConfig?.count || 0,
    ready: false,
    error: null,
  };
  const filmPreviewSources = new Map();
  let filmPreviewToken = 0;
  const LUT_ASSET_VERSION = "20261001-acr-measured";
  function parseLutAsset(buffer, assetName) {
      const view = new DataView(buffer);
      const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
      const size = view.getUint32(8, true);
      const count = view.getUint32(12, true);
      if (magic !== "FWLUT32\0" || size !== lutState.size || count !== filmPresets.length) {
        throw new Error(`${assetName} header mismatch`);
      }
      return { buffer, size, count };
  }
  const lutReady = fetch(`film-luts.bin?v=${LUT_ASSET_VERSION}`)
    .then((response) => {
      if (!response.ok) throw new Error(`LUT asset ${response.status}`);
      return response.arrayBuffer();
    })
    .then(async (buffer) => {
      const rawAsset = parseLutAsset(buffer, "RAW LUT asset");
      lutState.buffer = rawAsset.buffer;
      const responses = await Promise.all([
        fetch(`film-luts-rendered.bin?v=${LUT_ASSET_VERSION}`),
        fetch(`film-luts-raw.bin?v=${LUT_ASSET_VERSION}`),
      ]);
      if (responses.some((response) => !response.ok)) throw new Error("Input LUT asset unavailable");
      const [renderedBuffer, rawBuffer] = await Promise.all(responses.map((response) => response.arrayBuffer()));
      lutState.renderedBuffer = parseLutAsset(renderedBuffer, "Rendered LUT asset").buffer;
      lutState.rawBuffer = parseLutAsset(rawBuffer, "Decoder-input LUT asset").buffer;
      lutState.size = rawAsset.size;
      lutState.count = rawAsset.count;
      lutState.ready = true;
      if (state.imageLoaded) {
        render();
        generateFilmPreviews();
      }
      return buffer;
    })
    .catch((error) => {
      lutState.error = error;
      showToast("主配置资源暂时不可用");
      console.error("Film LUT asset load failed", error);
      if (!state.imageLoaded) renderStatus.textContent = `配置资源失败 · ${error?.message || error}`;
      return null;
    });

  function cloneValues() {
    const copy = {};
    Object.keys(defaultValues).forEach((key) => { copy[key] = state[key]; });
    return copy;
  }

  function snapshot() {
    return {
      ...cloneValues(),
      selectedFilm: state.selectedFilm,
      rotation: state.rotation,
      flipH: state.flipH,
      cropRect: state.cropRect ? { ...state.cropRect } : null,
    };
  }

  function restore(snapshotValue) {
    Object.assign(state, snapshotValue);
    if (!filmPresets.some((film) => film.id === state.selectedFilm)) state.selectedFilm = defaultFilmId;
    syncControls();
    renderFilmCards();
    render();
  }

  function pushHistory() {
    const value = snapshot();
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(value);
    state.historyIndex = state.history.length - 1;
    if (state.history.length > 40) {
      state.history.shift();
      state.historyIndex -= 1;
    }
    renderHistory();
  }

  function undo() {
    if (state.historyIndex <= 0) return showToast("已经是最早的调整");
    state.historyIndex -= 1;
    restore(state.history[state.historyIndex]);
    showToast("已撤销");
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return showToast("没有可重做的调整");
    state.historyIndex += 1;
    restore(state.history[state.historyIndex]);
    showToast("已重做");
  }

  function resetAll() {
    pushHistory();
    Object.assign(state, defaultValues, { selectedFilm: defaultFilmId, rotation: 0, flipH: false, before: false, compare: false, cropRect: null });
    syncControls();
    renderFilmCards();
    render();
    showToast("已重置全部设置");
  }

  function formatValue(field, value) {
    if (field === "exposure") return `${Number(value).toFixed(2)}`;
    if (field === "straighten") return `${Number(value).toFixed(1)}°`;
    if (["filmFormat", "filter", "frameStyle", "aspect", "outputFormat", "outputMedium"].includes(field)) return value;
    return `${Math.round(Number(value))}`;
  }

  function syncControls() {
    $$('[data-field]').forEach((control) => {
      if (state[control.dataset.field] !== undefined) control.value = state[control.dataset.field];
    });
    $$('[data-output]').forEach((output) => {
      const key = output.dataset.output;
      if (state[key] !== undefined) output.textContent = formatValue(key, state[key]);
    });
    const activeFilm = filmPresets.find((film) => film.id === state.selectedFilm) || filmPresets[0];
    activeFilmLabel.textContent = activeFilm?.name || "ACROS 100";
    if (favoriteButton) {
      const saved = state.savedFilms.includes(state.selectedFilm);
      favoriteButton.textContent = saved ? "★" : "☆";
      favoriteButton.setAttribute("aria-label", saved ? "取消收藏" : "收藏胶片");
      favoriteButton.setAttribute("aria-pressed", String(saved));
    }
    zoomLabel.textContent = state.zoom === 1 ? "适合" : `${Math.round(state.zoom * 100)}%`;
    const modeName = ({ develop: "调整", print: "输出", crop: "裁剪" })[state.mode] || "调整";
    $("#mobileMode").textContent = modeName;
    if (modePanelEyebrow) modePanelEyebrow.textContent = modeName;
    if (modePanelTitle) modePanelTitle.textContent = modeName;
    $$(".mode-tab").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
    $$('[data-mobile-nav]').forEach((button) => button.classList.toggle("active", button.dataset.mobileNav === state.mobileNav));
    syncModeSections();
    document.body.classList.toggle("before-mode", state.before);
  }

  function syncModeSections() {
    const visible = {
      develop: new Set(["light", "color", "film", "grain", "halation", "lens", "histogram"]),
      print: new Set(["screen", "frame", "output", "histogram"]),
      crop: new Set(["crop"]),
    }[state.mode] || new Set();
    $$('[data-section]').forEach((section) => section.classList.toggle("mode-hidden", !visible.has(section.dataset.section)));
    updateCropOverlay();
  }

  function renderFilmCards() {
    const scrollTop = filmGrid.parentElement?.scrollTop || 0;
    const query = filmSearch.value.trim().toLowerCase();
    const filtered = filmPresets.filter((film) => `${film.name} ${film.meta}`.toLowerCase().includes(query));
    filmGrid.innerHTML = filtered.map((film) => {
      const saved = state.savedFilms.includes(film.id);
      const preview = filmPreviewSources.get(film.id) || `film-previews/${film.id}.jpg`;
      return `
      <button class="film-card ${state.selectedFilm === film.id ? "active" : ""}" data-film="${film.id}" style="--swatch:${film.swatch}" aria-label="选择 ${film.name}">
        <span class="film-card-preview" aria-hidden="true"><img src="${preview}" alt="" loading="lazy" decoding="async"></span>
        <span class="film-card-star${saved ? " saved" : ""}" data-favorite-film="${film.id}" title="${saved ? "取消收藏" : "收藏"} ${film.name}" aria-label="${saved ? "取消收藏" : "收藏"} ${film.name}">${saved ? "★" : "☆"}</span>
        <span class="film-card-copy"><span class="film-card-name">${film.name}</span><span class="film-card-meta">${film.meta}</span></span>
      </button>`;
    }).join("");
    $$('[data-film]', filmGrid).forEach((card) => card.addEventListener("click", (event) => {
      const favorite = event.target.closest("[data-favorite-film]");
      if (favorite) {
        event.preventDefault();
        toggleFavorite(favorite.dataset.favoriteFilm);
        return;
      }
      selectFilm(card.dataset.film);
    }));
    if (filmGrid.parentElement) filmGrid.parentElement.scrollTop = scrollTop;
    renderSavedFilms();
  }

  function renderSavedFilms() {
    if (!state.savedFilms.length) {
      savedList.innerHTML = '<div class="history-item"><div><strong>还没有收藏</strong><span>在胶片卡片上点 ☆</span></div></div>';
      return;
    }
    savedList.innerHTML = state.savedFilms.map((id) => {
      const film = filmPresets.find((item) => item.id === id);
      const preview = filmPreviewSources.get(id) || `film-previews/${id}.jpg`;
      return `<button class="saved-item" data-saved-film="${id}">
        <span class="saved-item-preview" aria-hidden="true"><img src="${preview}" alt="" loading="lazy" decoding="async"></span>
        <span class="saved-item-copy"><strong>${film?.name || id}</strong><span>${film?.meta || "色彩配置"}</span></span>
        <span class="saved-item-star" aria-hidden="true">★</span>
      </button>`;
    }).join("");
    $$('[data-saved-film]', savedList).forEach((card) => card.addEventListener("click", () => selectFilm(card.dataset.savedFilm)));
  }

  function renderHistory() {
    if (!state.history.length) {
      historyList.innerHTML = '<div class="history-item"><div><strong>调整历史为空</strong><span>修改参数后会显示在这里</span></div></div>';
      return;
    }
    const items = state.history.slice().reverse().slice(0, 12);
    historyList.innerHTML = items.map((item, index) => {
      const film = filmPresets.find((f) => f.id === item.selectedFilm);
      return `<button class="history-item" data-history-index="${state.history.length - 1 - index}"><span><strong>${film?.name || filmPresets[0]?.name || "ACROS 100"}</strong><span>步骤 ${state.history.length - index}</span></span><span>›</span></button>`;
    }).join("");
    $$('[data-history-index]', historyList).forEach((item) => item.addEventListener("click", () => {
      state.historyIndex = Number(item.dataset.historyIndex);
      restore(state.history[state.historyIndex]);
    }));
  }

  function selectFilm(id) {
    const film = filmPresets.find((item) => item.id === id);
    if (!film) return;
    pushHistory();
    state.selectedFilm = id;
    // A profile is the complete first-pass transform. Selecting it must not
    // inject a hidden look into the second-pass inspector controls.
    Object.assign(state, defaultValues, { selectedFilm: id });
    syncControls();
    renderFilmCards();
    render();
    showToast(`${film.name} 主配置已应用，二次调色保持中性`);
  }

  function activeValues(useBefore = state.before) {
    if (useBefore) return { ...defaultValues, selectedFilm: defaultFilmId, filmAmount: 0 };
    return { ...state };
  }

  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) return [l, l, l];
    const hue = (n) => {
      const k = (n + h * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [hue(0), hue(8), hue(4)];
  }

  function hashNoise(x, y, seed) {
    const n = Math.sin((x * 12.9898 + y * 78.233 + seed * 37.719)) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1;
  }

  const colorMatrices = lutConfig?.matrices || {};
  const acr3Inverse = Array.isArray(lutConfig?.acr3Inverse) ? lutConfig.acr3Inverse : [];
  const adobeRgbToXyz = [
    [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
    [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
    [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
  ];
  // D65/D50 matrices for the common photographic working spaces.  The canvas
  // API does not expose the source ICC profile, so the importer detects the
  // profile description and keeps the encoded samples untouched until this
  // explicit conversion reaches the film LUT.
  const displayP3ToXyz = [
    [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
    [0, 0.04511338185890264, 1.043944368900976],
  ];
  const rec2020ToXyz = [
    [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
    [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
    [0, 0.028072693049087428, 1.060985057710791],
  ];
  const prophotoToXyzD50 = colorMatrices.prophotoToXyz;
  const acr3ForwardTable = new Float32Array(4097);

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

  function inputColorSettings(values = null) {
    const colorSpace = values?.inputColorSpace || state.imageColorSpace || "srgb";
    const profiles = {
      "adobe-rgb": { matrix: adobeRgbToXyz, decode: adobeRgbDecode, white: "d65" },
      "display-p3": { matrix: displayP3ToXyz, decode: srgbDecode, white: "d65" },
      "prophoto-rgb": { matrix: prophotoToXyzD50, decode: prophotoDecode, white: "d50" },
      "rec2020": { matrix: rec2020ToXyz, decode: rec2020Decode, white: "d65" },
      srgb: { matrix: colorMatrices.srgbToXyz, decode: srgbDecode, white: "d65" },
    };
    const selected = profiles[colorSpace] || profiles.srgb;
    return {
      matrix: selected.matrix,
      decode: selected.decode,
      white: selected.white,
      applyAcr3: values?.imageApplyAcr3 ?? values?.inputApplyAcr3 ?? state.imageApplyAcr3,
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

  function inverseAcr3Tone(value) {
    if (acr3Inverse.length !== 1025) return value;
    const input = clamp01(value);
    let low = 0;
    let high = acr3Inverse.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (acr3Inverse[middle] <= input) low = middle;
      else high = middle;
    }
    const span = acr3Inverse[high] - acr3Inverse[low];
    const fraction = span > 0 ? (input - acr3Inverse[low]) / span : 0;
    return (low + fraction) / (acr3Inverse.length - 1);
  }

  for (let index = 0; index < acr3ForwardTable.length; index += 1) {
    acr3ForwardTable[index] = inverseAcr3Tone(index / (acr3ForwardTable.length - 1));
  }

  function acr3Forward(value) {
    const position = clamp01(value) * (acr3ForwardTable.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(acr3ForwardTable.length - 1, lower + 1);
    const fraction = position - lower;
    return acr3ForwardTable[lower] * (1 - fraction) + acr3ForwardTable[upper] * fraction;
  }

  function samplePrimaryLut(lut, red, green, blue) {
    const size = lutState.size;
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

  function getPrimaryLut() {
    if (!lutState.ready || !lutState.buffer) return null;
    const profile = filmPresets.find((item) => item.id === state.selectedFilm) || filmPresets[0];
    if (!profile) return null;
    const buffer = state.rawImage ? lutState.rawBuffer : lutState.renderedBuffer;
    const offset = lutConfig.headerBytes + profile.index * lutConfig.voxelBytes;
    return new Uint16Array(buffer, offset, lutState.size ** 3 * 3);
  }

  function getFilmLut(profile) {
    if (!lutState.ready || !lutState.buffer || !profile) return null;
    const buffer = state.rawImage ? lutState.rawBuffer : lutState.renderedBuffer;
    const offset = lutConfig.headerBytes + profile.index * lutConfig.voxelBytes;
    return new Uint16Array(buffer, offset, lutState.size ** 3 * 3);
  }

  function applyPrimaryLut(source, amount = 1, values = null, lutOverride = null) {
    const lut = lutOverride || getPrimaryLut();
    if (!lut || !colorMatrices.srgbToXyz) return new Uint8ClampedArray(source);
    const input = inputColorSettings(values);
    const output = new Uint8ClampedArray(source);
    const mix = clamp01(amount);
    for (let index = 0; index < source.length; index += 4) {
      const original = [source[index] / 255, source[index + 1] / 255, source[index + 2] / 255];
      const linearInput = original.map(input.decode);
      const xyzD65 = input.white === "d50"
        ? matrixVector(colorMatrices.d50ToD65, matrixVector(input.matrix, linearInput))
        : matrixVector(input.matrix, linearInput);
      const xyzD50 = matrixVector(colorMatrices.d65ToD50, xyzD65);
      const proLinear = matrixVector(colorMatrices.xyzToProphoto, xyzD50);
      const proEncoded = proLinear.map((value) => clamp01(prophotoEncode(input.applyAcr3 ? acr3Forward(value) : value)));
      const mappedPro = samplePrimaryLut(lut, proEncoded[0], proEncoded[1], proEncoded[2]);
      const mappedProLinear = mappedPro.map(prophotoDecode);
      const mappedXyzD50 = matrixVector(colorMatrices.prophotoToXyz, mappedProLinear);
      const mappedXyzD65 = matrixVector(colorMatrices.d50ToD65, mappedXyzD50);
      const mappedLinearSrgb = matrixVector(colorMatrices.xyzToSrgb, mappedXyzD65).map(clamp01);
      const mapped = mappedLinearSrgb.map(srgbEncode);
      output[index] = Math.round((original[0] * (1 - mix) + mapped[0] * mix) * 255);
      output[index + 1] = Math.round((original[1] * (1 - mix) + mapped[1] * mix) * 255);
      output[index + 2] = Math.round((original[2] * (1 - mix) + mapped[2] * mix) * 255);
    }
    return output;
  }

  function applyRaw16Lut(source, width, height, amount = 1, values = null, outputType = "rgba8", lutOverride = null) {
    const lut = lutOverride || getPrimaryLut();
    const Output = outputType === "rgba16" ? Uint16Array : Uint8ClampedArray;
    const output = new Output(width * height * 4);
    if (!lut || !colorMatrices.srgbToXyz) return output;
    const mix = clamp01(amount);
    const scale = outputType === "rgba16" ? 65535 : 255;
    // LibRaw's uint16 samples are scene-linear values with a per-file white
    // point.  The upstream decoder exposes that point as sceneScale; applying
    // it before the matrix keeps RAW exposure consistent with Phocus/ACR.
    const sceneScale = Number(values?.rawSceneScale);
    const sceneFactor = Number.isFinite(sceneScale) && sceneScale > 0 ? sceneScale : 1;
    const applyAcr3 = Boolean(values?.imageApplyAcr3 ?? state.imageApplyAcr3);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const si = pixel * 3;
      const original = [source[si] * sceneFactor / 65535, source[si + 1] * sceneFactor / 65535, source[si + 2] * sceneFactor / 65535];
      const xyzD65 = matrixVector(rec2020ToXyz, original);
      const xyzD50 = matrixVector(colorMatrices.d65ToD50, xyzD65);
      const proLinear = matrixVector(colorMatrices.xyzToProphoto, xyzD50);
      const proEncoded = proLinear.map((value) => clamp01(prophotoEncode(applyAcr3 ? acr3Forward(value) : value)));
      const mapped = samplePrimaryLut(lut, proEncoded[0], proEncoded[1], proEncoded[2]);
      const mappedXyzD65 = matrixVector(colorMatrices.d50ToD65, matrixVector(colorMatrices.prophotoToXyz, mapped.map(prophotoDecode)));
      const mappedRgb = matrixVector(colorMatrices.xyzToSrgb, mappedXyzD65).map(clamp01).map(srgbEncode);
      const baseRgb = matrixVector(colorMatrices.xyzToSrgb, xyzD65).map(clamp01).map(srgbEncode);
      const oi = pixel * 4;
      output[oi] = Math.round((baseRgb[0] * (1 - mix) + mappedRgb[0] * mix) * scale);
      output[oi + 1] = Math.round((baseRgb[1] * (1 - mix) + mappedRgb[1] * mix) * scale);
      output[oi + 2] = Math.round((baseRgb[2] * (1 - mix) + mappedRgb[2] * mix) * scale);
      output[oi + 3] = scale;
    }
    return output;
  }

  function applyRgba16Lut(source, width, height, amount = 1, values = null, outputType = "rgba8", lutOverride = null) {
    const lut = lutOverride || getPrimaryLut();
    const Output = outputType === "rgba16" ? Uint16Array : Uint8ClampedArray;
    const output = new Output(width * height * 4);
    if (!lut || !colorMatrices.srgbToXyz) return output;
    const input = inputColorSettings(values);
    const mix = clamp01(amount);
    const scale = outputType === "rgba16" ? 65535 : 255;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const si = pixel * 4;
      const original = [source[si] / 65535, source[si + 1] / 65535, source[si + 2] / 65535];
      const linearInput = original.map(input.decode);
      const xyzD65 = input.white === "d50"
        ? matrixVector(colorMatrices.d50ToD65, matrixVector(input.matrix, linearInput))
        : matrixVector(input.matrix, linearInput);
      const xyzD50 = matrixVector(colorMatrices.d65ToD50, xyzD65);
      const proLinear = matrixVector(colorMatrices.xyzToProphoto, xyzD50);
      const proEncoded = proLinear.map((value) => clamp01(prophotoEncode(input.applyAcr3 ? acr3Forward(value) : value)));
      const mapped = samplePrimaryLut(lut, proEncoded[0], proEncoded[1], proEncoded[2]);
      const mappedXyzD65 = matrixVector(colorMatrices.d50ToD65, matrixVector(colorMatrices.prophotoToXyz, mapped.map(prophotoDecode)));
      const mappedRgb = matrixVector(colorMatrices.xyzToSrgb, mappedXyzD65).map(clamp01).map(srgbEncode);
      const baseRgb = matrixVector(colorMatrices.xyzToSrgb, xyzD65).map(clamp01).map(srgbEncode);
      const oi = pixel * 4;
      output[oi] = Math.round((baseRgb[0] * (1 - mix) + mappedRgb[0] * mix) * scale);
      output[oi + 1] = Math.round((baseRgb[1] * (1 - mix) + mappedRgb[1] * mix) * scale);
      output[oi + 2] = Math.round((baseRgb[2] * (1 - mix) + mappedRgb[2] * mix) * scale);
      output[oi + 3] = scale;
    }
    return output;
  }

  // The primary LUT and secondary pixel controls are the heaviest part of a
  // preview render. Keep a small pool alive and split the image into row
  // ranges so the main UI thread can continue handling sliders and scrolling.
  const lutWorkerPool = {
    workers: [],
    pending: new Map(),
    nextId: 1,
    disabled: false,
  };
  let activeLutTask = null;
  let queuedLutTask = null;

  function workerCount() {
    const cores = Number(window.navigator.hardwareConcurrency) || 2;
    return Math.min(4, Math.max(2, cores));
  }

  function disableLutWorkers() {
    lutWorkerPool.disabled = true;
    lutWorkerPool.workers.forEach((worker) => worker.terminate());
    lutWorkerPool.workers = [];
    lutWorkerPool.pending.forEach(({ reject }) => reject(new Error("LUT worker unavailable")));
    lutWorkerPool.pending.clear();
  }

  function getLutWorkerPool() {
    if (lutWorkerPool.disabled || typeof Worker === "undefined" || !lutConfig) return null;
    if (lutWorkerPool.workers.length) return lutWorkerPool;
    try {
      const init = {
        type: "init",
        size: lutState.size,
        matrices: colorMatrices,
        acr3Inverse,
      };
      for (let index = 0; index < workerCount(); index += 1) {
        const worker = new Worker(`pixel-worker.js?v=${LUT_ASSET_VERSION}`);
        worker.addEventListener("message", (event) => {
          const message = event.data || {};
          if (!message.id) return;
          const pending = lutWorkerPool.pending.get(message.id);
          if (!pending) return;
          lutWorkerPool.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message);
        });
        worker.addEventListener("error", () => disableLutWorkers());
        worker.postMessage(init);
        lutWorkerPool.workers.push(worker);
      }
      return lutWorkerPool;
    } catch {
      disableLutWorkers();
      return null;
    }
  }

  function workerValues(values) {
    const fields = [
      "exposure", "contrast", "highlights", "shadows", "temperature", "tint",
      "saturation", "vibrance", "grain", "grainSize", "grainColor", "bleach", "age",
      "halation", "halationReturn", "haloHue", "vignette", "distortion", "filter", "selectedFilm",
      "filmFormat", "push", "negativeViewing", "viewingIlluminant",
      "paperGrade", "screenExposure", "enlarger", "printerPreflash", "outputMedium",
      "rawSceneScale",
      "imageColorSpace", "imageApplyAcr3",
    ];
    return fields.reduce((result, field) => {
      result[field] = values?.[field];
      return result;
    }, {});
  }

  function runLutWorkerChunks(source, width, height, amount, values, options = {}) {
    const pool = getLutWorkerPool();
    const lut = options.lut || getPrimaryLut();
    const sourceType = options.sourceType || "rgba8";
    const outputType = options.outputType || "rgba8";
    if (!pool || !lut || !colorMatrices.srgbToXyz) {
      if (sourceType === "raw16") {
        const result = applyRaw16Lut(source, width, height, amount, values, outputType, lut);
        return Promise.resolve({ data: outputType === "rgba8" ? processPixels(result, width, height, values) : result, secondaryApplied: outputType === "rgba8" });
      }
      if (sourceType === "rgba16") {
        const result = applyRgba16Lut(source, width, height, amount, values, outputType, lut);
        return Promise.resolve({ data: outputType === "rgba8" ? processPixels(result, width, height, values) : result, secondaryApplied: outputType === "rgba8" });
      }
      return Promise.resolve({ data: applyPrimaryLut(source, amount, values, lut), secondaryApplied: false });
    }
    const workerTotal = Math.min(pool.workers.length, Math.max(1, height));
    const rowsPerWorker = Math.ceil(height / workerTotal);
    const jobs = [];
    for (let workerIndex = 0; workerIndex < workerTotal; workerIndex += 1) {
      const startRow = workerIndex * rowsPerWorker;
      const endRow = Math.min(height, startRow + rowsPerWorker);
      if (startRow >= endRow) continue;
      const channels = sourceType === "raw16" ? 3 : 4;
      const start = startRow * width * channels;
      const end = endRow * width * channels;
      const chunk = source.slice(start, end);
      const lutBuffer = lut.buffer.slice(lut.byteOffset, lut.byteOffset + lut.byteLength);
      const id = lutWorkerPool.nextId++;
      const worker = pool.workers[workerIndex % pool.workers.length];
      jobs.push(new Promise((resolve, reject) => {
        pool.pending.set(id, { resolve, reject });
        worker.postMessage({
          type: "render",
          id,
          startRow,
          width,
          height: endRow - startRow,
          fullHeight: height,
          amount,
          values,
          colorSpace: values?.imageColorSpace || state.imageColorSpace || "srgb",
          applyAcr3: Boolean(values?.imageApplyAcr3 ?? state.imageApplyAcr3),
          sourceType,
          outputType,
          buffer: chunk.buffer,
          lutBuffer,
        }, [chunk.buffer, lutBuffer]);
      }));
    }
    return Promise.all(jobs).then((chunks) => {
      const Output = outputType === "rgba16" ? Uint16Array : Uint8ClampedArray;
      const output = new Output(sourceType === "raw16" ? width * height * 4 : source.length);
      if (sourceType !== "raw16") output.set(source);
      const channels = outputType === "rgba16" || sourceType === "raw16" ? 4 : 4;
      chunks.forEach((chunk) => output.set(new Output(chunk.buffer), chunk.startRow * width * channels));
      return { data: output, secondaryApplied: true };
    });
  }

  function applyPrimaryLutParallel(source, width, height, amount = 1, values = null) {
    if (!getPrimaryLut() || amount <= 0) return Promise.resolve({ data: new Uint8ClampedArray(source), secondaryApplied: false });
    const request = { source, width, height, amount, values: workerValues(values), resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    if (queuedLutTask) queuedLutTask.resolve({ data: new Uint8ClampedArray(queuedLutTask.source), secondaryApplied: false });
    queuedLutTask = request;

    const drain = async () => {
      if (activeLutTask || !queuedLutTask) return;
      activeLutTask = queuedLutTask;
      queuedLutTask = null;
      try {
        activeLutTask.resolve(await runLutWorkerChunks(activeLutTask.source, activeLutTask.width, activeLutTask.height, activeLutTask.amount, activeLutTask.values));
      } catch (error) {
        // A browser can block workers when the page is opened directly from
        // disk. Preserve functionality with the exact synchronous fallback.
        disableLutWorkers();
        activeLutTask.resolve({ data: applyPrimaryLut(activeLutTask.source, activeLutTask.amount, activeLutTask.values), secondaryApplied: false });
      } finally {
        activeLutTask = null;
        if (queuedLutTask) drain();
      }
    };
    drain();
    return promise;
  }

  function processPixels(source, width, height, values) {
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
    if (!hasSecondaryWork) return source;
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
    const temp = ((Number(values.temperature) || 0) / 100)
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
    const seed = String(values.selectedFilm || state.selectedFilm).length * 17 + 11;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const original = [source[i] / 255, source[i + 1] / 255, source[i + 2] / 255];
        let [r, g, b] = original;
        r *= exposure; g *= exposure; b *= exposure;
        r = (r - 0.5) * contrast + 0.5;
        g = (g - 0.5) * contrast + 0.5;
        b = (b - 0.5) * contrast + 0.5;
        const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const shadowMix = Math.max(0, 0.55 - lum) / 0.55;
        const highlightMix = Math.max(0, lum - 0.45) / 0.55;
        r += shadow * shadowMix * 0.18 + highlight * highlightMix * 0.14;
        g += shadow * shadowMix * 0.18 + highlight * highlightMix * 0.14;
        b += shadow * shadowMix * 0.18 + highlight * highlightMix * 0.14;
        r += temp * 0.11 - tint * 0.035;
        g += tint * 0.08;
        b -= temp * 0.11 - tint * 0.035;
        if (filter === "Warm 1/8" || filter === "Warm 1/4") {
          const strength = filter === "Warm 1/4" ? 0.055 : 0.028;
          r += strength; g += strength * 0.35; b -= strength * 0.75;
        } else if (filter === "Black Mist 1/8") {
          const mist = 0.035;
          r = r * (1 - mist) + 0.5 * mist; g = g * (1 - mist) + 0.5 * mist; b = b * (1 - mist) + 0.5 * mist;
        } else if (filter === "Glimmer 1/4") {
          r += Math.max(0, lum - 0.52) * 0.07; g += Math.max(0, lum - 0.52) * 0.035;
        } else if (filter === "Fog 1/8") {
          r = r * 0.96 + 0.04; g = g * 0.96 + 0.04; b = b * 0.96 + 0.04;
        }

        const [h, s, l] = rgbToHsl(Math.max(0, r), Math.max(0, g), Math.max(0, b));
        const vivid = vib >= 0 ? vib * (1 - s) : vib;
        [r, g, b] = hslToRgb(h, Math.max(0, Math.min(1, s * sat + vivid)), l);
        const gray = (r + g + b) / 3;
        r = r * (1 - bleach * 0.52) + gray * bleach * 0.52;
        g = g * (1 - bleach * 0.52) + gray * bleach * 0.52;
        b = b * (1 - bleach * 0.52) + gray * bleach * 0.52;
        r = r * (1 - age * 0.12) + age * 0.05;
        g = g * (1 - age * 0.16) + age * 0.035;
        b = b * (1 - age * 0.20) + age * 0.015;
        if (Number(values.printerPreflash) > 0) {
          const preflash = Math.min(1, Number(values.printerPreflash) / 100) * Math.max(0, 1 - lum) * 0.12;
          r += preflash; g += preflash; b += preflash;
        }

        const dx = x / Math.max(1, width - 1) - 0.5;
        const dy = y / Math.max(1, height - 1) - 0.5;
        const edge = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.45);
        const vignetteFactor = 1 - vignette * edge * edge * 0.65;
        r *= vignetteFactor; g *= vignetteFactor; b *= vignetteFactor;
        if (distortion !== 0) {
          const warp = distortion * edge * edge * 0.045;
          r += warp * 0.7; g += warp * 0.3; b -= warp * 0.4;
        }

        if (halation > 0 && lum > 0.64) {
          const glow = ((lum - 0.64) / 0.36) * halation * (0.12 + Number(values.halationReturn || 25) / 100 * 0.24) * formatScale;
          const hue = Math.max(0, Number(values.haloHue) || 12) / 360;
          const halo = hslToRgb(hue, 0.72, 0.52);
          r += glow * halo[0];
          g += glow * halo[1];
          b += glow * halo[2];
        }

        if (grainAmount > 0) {
          const gx = Math.floor(x / grainSize) * grainSize;
          const gy = Math.floor(y / grainSize) * grainSize;
          const noise = hashNoise(gx, gy, seed);
          const strength = grainAmount * formatScale * (0.045 + Number(values.grainSize) / 100 * 0.055);
          r += noise * strength;
          g += noise * strength * (0.84 + grainColor * 0.12);
          b += noise * strength * (0.72 + grainColor * 0.24);
        }

        output[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
        output[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
        output[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      }
    }
    return output;
  }

  function fitSize() {
    if (!state.imageLoaded || !state.image) return { width: 0, height: 0 };
    const stageStyle = window.getComputedStyle(stage);
    const horizontalPadding = parseFloat(stageStyle.paddingLeft || 0) + parseFloat(stageStyle.paddingRight || 0);
    const verticalPadding = parseFloat(stageStyle.paddingTop || 0) + parseFloat(stageStyle.paddingBottom || 0);
    const availableWidth = Math.max(240, stage.clientWidth - horizontalPadding);
    const availableHeight = Math.max(200, stage.clientHeight - verticalPadding);
    const sourceWidth = state.image.naturalWidth || state.image.width;
    const sourceHeight = state.image.naturalHeight || state.image.height;
    const sourceRatio = sourceWidth / sourceHeight;
    let width = Math.min(availableWidth, sourceWidth);
    let height = width / sourceRatio;
    if (height > availableHeight) { height = availableHeight; width = height * sourceRatio; }
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }

  function previewSize() {
    const displaySize = fitSize();
    if (!displaySize.width || !displaySize.height) return displaySize;
    const sourceWidth = Number(state.rawImage?.width || state.deepImage?.width || state.image?.naturalWidth || state.image?.width || displaySize.width);
    const sourceHeight = Number(state.rawImage?.height || state.deepImage?.height || state.image?.naturalHeight || state.image?.height || displaySize.height);
    const ratio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : displaySize.width / displaySize.height;
    const minimumLongEdge = 2000;
    const maximumLongEdge = 4096;
    const longEdge = Math.min(maximumLongEdge, Math.max(minimumLongEdge, displaySize.width, displaySize.height));
    if (ratio >= 1) {
      return { width: longEdge, height: Math.max(1, Math.round(longEdge / ratio)) };
    }
    return { width: Math.max(1, Math.round(longEdge * ratio)), height: longEdge };
  }

  // Keep the interactive preview light, but never use its display-sized canvas
  // as the source for an export.  A 120 MP ceiling prevents an accidental
  // browser allocation failure while preserving the native size of ordinary
  // camera files.
  function fullResolutionSize() {
    if (!state.imageLoaded || !state.image) return { width: 0, height: 0 };
    const rawWidth = Number(state.rawImage?.width || state.deepImage?.width || state.image.naturalWidth || state.image.width);
    const rawHeight = Number(state.rawImage?.height || state.deepImage?.height || state.image.naturalHeight || state.image.height);
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) return fitSize();
    const maxPixels = 120_000_000;
    const scale = Math.min(1, Math.sqrt(maxPixels / (rawWidth * rawHeight)));
    return {
      width: Math.max(1, Math.round(rawWidth * scale)),
      height: Math.max(1, Math.round(rawHeight * scale)),
    };
  }

  function cropCanvasRect(source, rect) {
    if (!rect) return source;
    const x = Math.max(0, Math.min(0.999, Number(rect.x) || 0));
    const y = Math.max(0, Math.min(0.999, Number(rect.y) || 0));
    const width = Math.max(0.01, Math.min(1 - x, Number(rect.width) || 1));
    const height = Math.max(0.01, Math.min(1 - y, Number(rect.height) || 1));
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(source.width * width));
    crop.height = Math.max(1, Math.round(source.height * height));
    crop.getContext("2d").drawImage(
      source,
      Math.round(source.width * x), Math.round(source.height * y),
      Math.max(1, Math.round(source.width * width)), Math.max(1, Math.round(source.height * height)),
      0, 0, crop.width, crop.height,
    );
    return crop;
  }

  function cropCanvas(source, ratio) {
    if (!ratio || ratio === "free") return source;
    const current = source.width / source.height;
    let cropW = source.width, cropH = source.height;
    if (current > Number(ratio)) cropW = Math.round(source.height * Number(ratio));
    else cropH = Math.round(source.width / Number(ratio));
    const crop = document.createElement("canvas");
    crop.width = cropW; crop.height = cropH;
    crop.getContext("2d").drawImage(source, (source.width - cropW) / 2, (source.height - cropH) / 2, cropW, cropH, 0, 0, cropW, cropH);
    return crop;
  }

  function transformCanvas(source, values) {
    // A manually drawn crop is defined in the visible, post-rotation image
    // space.  Preset aspect crops keep the original centered behavior.
    let working = state.cropRect ? source : cropCanvas(source, values.aspect);
    const turns = ((state.rotation % 360) + 360) % 360;
    const swap = turns === 90 || turns === 270;
    const output = document.createElement("canvas");
    output.width = swap ? working.height : working.width;
    output.height = swap ? working.width : working.height;
    const outputContext = output.getContext("2d");
    outputContext.save();
    outputContext.translate(output.width / 2, output.height / 2);
    outputContext.rotate((turns * Math.PI) / 180);
    outputContext.scale(state.flipH ? -1 : 1, 1);
    outputContext.drawImage(working, -working.width / 2, -working.height / 2);
    outputContext.restore();
    let transformed = output;
    if (Math.abs(Number(values.straighten)) > 0.01) {
      const rotated = document.createElement("canvas");
      rotated.width = output.width; rotated.height = output.height;
      const rctx = rotated.getContext("2d");
      rctx.translate(rotated.width / 2, rotated.height / 2);
      rctx.rotate((Number(values.straighten) * Math.PI) / 180);
      rctx.drawImage(output, -output.width / 2, -output.height / 2);
      transformed = rotated;
    }
    if (state.cropRect) transformed = cropCanvasRect(transformed, state.cropRect);
    return renderFrame(transformed, values.frameStyle, values.frameSize);
  }

  function renderFrame(transformed, frameStyle, frameSizeValue) {
    if (!frameStyle || Number(frameSizeValue) <= 0) return transformed;
    const styleMap = {
      "Black Mount": "black",
      "White Mount": "white",
      "Square Post": "square",
      "Portrait Post": "polaroid",
      Story: "polaroid",
    };
    const style = styleMap[frameStyle] || frameStyle;
    const border = Math.max(1, Math.round(Math.min(transformed.width, transformed.height) * Number(frameSizeValue) / 100 * 0.12));
    const background = {
      black: "#121417",
      white: "#f4f0e8",
      gray: "#85878a",
      polaroid: "#f4efe5",
      square: "#f4f0e8",
    }[style] || "#121417";
    const framed = document.createElement("canvas");
    const frameContext = framed.getContext("2d");

    if (style === "square") {
      const side = Math.max(transformed.width, transformed.height) + border * 2;
      framed.width = side;
      framed.height = side;
      frameContext.fillStyle = background;
      frameContext.fillRect(0, 0, side, side);
      frameContext.drawImage(transformed, (side - transformed.width) / 2, (side - transformed.height) / 2);
      return framed;
    }

    if (style === "polaroid") {
      const frameRatio = 4 / 5;
      const minimumWidth = transformed.width + border * 2;
      const minimumHeight = transformed.height + border * 3;
      let width = Math.max(minimumWidth, Math.ceil(minimumHeight * frameRatio));
      let height = Math.ceil(width / frameRatio);
      if (height < minimumHeight) {
        height = minimumHeight;
        width = Math.ceil(height * frameRatio);
      }
      framed.width = width;
      framed.height = height;
      frameContext.fillStyle = background;
      frameContext.fillRect(0, 0, width, height);
      const innerWidth = width - border * 2;
      const innerHeight = height - border * 3;
      const scale = Math.min(innerWidth / transformed.width, innerHeight / transformed.height);
      const imageWidth = Math.max(1, Math.round(transformed.width * scale));
      const imageHeight = Math.max(1, Math.round(transformed.height * scale));
      frameContext.drawImage(transformed, (width - imageWidth) / 2, border, imageWidth, imageHeight);
      return framed;
    }

    framed.width = transformed.width + border * 2;
    framed.height = transformed.height + border * 2;
    frameContext.fillStyle = background;
    frameContext.fillRect(0, 0, framed.width, framed.height);
    frameContext.drawImage(transformed, border, border);
    return framed;
  }

  function downsampleRaw(size) {
    const raw = state.rawImage;
    if (!raw) return null;
    if (size.width === raw.width && size.height === raw.height && raw.colors !== 1) return raw.data;
    const output = new Uint16Array(size.width * size.height * 3);
    const channels = raw.colors === 1 ? 1 : 3;
    for (let y = 0; y < size.height; y += 1) {
      const sourceY = Math.min(raw.height - 1, Math.floor((y + 0.5) * raw.height / size.height));
      for (let x = 0; x < size.width; x += 1) {
        const sourceX = Math.min(raw.width - 1, Math.floor((x + 0.5) * raw.width / size.width));
        const sourceIndex = (sourceY * raw.width + sourceX) * channels;
        const destinationIndex = (y * size.width + x) * 3;
        if (channels === 1) {
          const value = raw.data[sourceIndex];
          output[destinationIndex] = value;
          output[destinationIndex + 1] = value;
          output[destinationIndex + 2] = value;
        } else {
          output[destinationIndex] = raw.data[sourceIndex];
          output[destinationIndex + 1] = raw.data[sourceIndex + 1];
          output[destinationIndex + 2] = raw.data[sourceIndex + 2];
        }
      }
    }
    return output;
  }

  function downsampleDeep(size) {
    const deep = state.deepImage;
    if (!deep) return null;
    if (size.width === deep.width && size.height === deep.height) return deep.data;
    const output = new Uint16Array(size.width * size.height * 4);
    for (let y = 0; y < size.height; y += 1) {
      const sourceY = Math.min(deep.height - 1, Math.floor((y + 0.5) * deep.height / size.height));
      for (let x = 0; x < size.width; x += 1) {
        const sourceX = Math.min(deep.width - 1, Math.floor((x + 0.5) * deep.width / size.width));
        const sourceIndex = (sourceY * deep.width + sourceX) * 4;
        const destinationIndex = (y * size.width + x) * 4;
        output[destinationIndex] = deep.data[sourceIndex];
        output[destinationIndex + 1] = deep.data[sourceIndex + 1];
        output[destinationIndex + 2] = deep.data[sourceIndex + 2];
        output[destinationIndex + 3] = deep.data[sourceIndex + 3];
      }
    }
    return output;
  }

  function previewThumbnailSize(maxLongEdge = 180) {
    const width = Number(state.rawImage?.width || state.deepImage?.width || state.image?.naturalWidth || state.image?.width);
    const height = Number(state.rawImage?.height || state.deepImage?.height || state.image?.naturalHeight || state.image?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: maxLongEdge, height: 112 };
    if (width >= height) return { width: maxLongEdge, height: Math.max(1, Math.round(maxLongEdge * height / width)) };
    return { width: Math.max(1, Math.round(maxLongEdge * width / height)), height: maxLongEdge };
  }

  async function generateFilmPreviews() {
    const token = ++filmPreviewToken;
    if (!state.imageLoaded || !state.image) return;
    if (!lutState.ready) {
      await lutReady;
      if (token !== filmPreviewToken) return;
    }
    if (!lutState.ready) return;
    const size = previewThumbnailSize();
    let source = null;
    let sourceType = "rgba8";
    if (state.rawImage) {
      source = downsampleRaw(size);
      sourceType = "raw16";
    } else if (state.deepImage) {
      source = downsampleDeep(size);
      sourceType = "rgba16";
    } else {
      const thumbnail = document.createElement("canvas");
      thumbnail.width = size.width;
      thumbnail.height = size.height;
      thumbnail.getContext("2d", { willReadFrequently: true }).drawImage(state.image, 0, 0, size.width, size.height);
      source = thumbnail.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, size.width, size.height).data;
    }
    const values = {
      ...defaultValues,
      selectedFilm: defaultFilmId,
      imageColorSpace: state.imageColorSpace,
      imageApplyAcr3: Boolean(state.rawImage),
      rawSceneScale: state.rawImage?.sceneScale || 1,
    };
    filmPreviewSources.clear();
    renderFilmCards();
    let cursor = 0;
    const concurrency = Math.min(4, Math.max(2, Number(window.navigator.hardwareConcurrency) || 2));
    const renderOne = async () => {
      while (true) {
        const index = cursor++;
        if (index >= filmPresets.length || token !== filmPreviewToken) return;
        const film = filmPresets[index];
        const lut = getFilmLut(film);
        if (!lut) continue;
        try {
          const transformed = await runLutWorkerChunks(
            source,
            size.width,
            size.height,
            1,
            { ...values, selectedFilm: film.id },
            { lut, sourceType, outputType: "rgba8" },
          );
          if (token !== filmPreviewToken) return;
          const thumbnail = document.createElement("canvas");
          thumbnail.width = size.width;
          thumbnail.height = size.height;
          thumbnail.getContext("2d").putImageData(new ImageData(transformed.data, size.width, size.height), 0, 0);
          filmPreviewSources.set(film.id, thumbnail.toDataURL("image/jpeg", 0.82));
          renderFilmCards();
        } catch (error) {
          console.warn("Film preview failed", film.id, error);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, renderOne));
  }

  function convertInputToSrgb(source) {
    if (state.imageColorSpace === "srgb") return new Uint8ClampedArray(source);
    const output = new Uint8ClampedArray(source);
    const input = inputColorSettings({ inputColorSpace: state.imageColorSpace, imageApplyAcr3: false });
    for (let index = 0; index < source.length; index += 4) {
      const encoded = [source[index] / 255, source[index + 1] / 255, source[index + 2] / 255];
      const linear = encoded.map(input.decode);
      const xyz = input.white === "d50"
        ? matrixVector(colorMatrices.d50ToD65, matrixVector(input.matrix, linear))
        : matrixVector(input.matrix, linear);
      const srgbLinear = matrixVector(colorMatrices.xyzToSrgb, xyz).map(clamp01);
      const converted = srgbLinear.map(srgbEncode);
      output[index] = Math.round(converted[0] * 255);
      output[index + 1] = Math.round(converted[1] * 255);
      output[index + 2] = Math.round(converted[2] * 255);
    }
    return output;
  }

  async function makeProcessedCanvas(useBefore = false, options = {}) {
    if (!state.imageLoaded || !state.image) return null;
    const size = options.fullResolution ? fullResolutionSize() : previewSize();
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = size.width; sourceCanvas.height = size.height;
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    const values = activeValues(useBefore);
    if (state.rawImage || state.deepImage) {
      const deepPixels = state.rawImage ? downsampleRaw(size) : downsampleDeep(size);
      const transformed = await runLutWorkerChunks(
        deepPixels,
        size.width,
        size.height,
        useBefore ? 0 : Number(values.filmAmount) / 100,
        { ...values, imageApplyAcr3: state.imageApplyAcr3, rawSceneScale: state.rawImage?.sceneScale || 1 },
        { sourceType: state.rawImage ? "raw16" : "rgba16", outputType: "rgba8" },
      );
      const data = new ImageData(transformed.data, size.width, size.height);
      sourceContext.putImageData(data, 0, 0);
    } else {
      sourceContext.drawImage(state.image, 0, 0, size.width, size.height);
      const data = sourceContext.getImageData(0, 0, size.width, size.height);
      const transformed = useBefore
        ? { data: convertInputToSrgb(data.data), secondaryApplied: false }
        : await applyPrimaryLutParallel(data.data, size.width, size.height, Number(values.filmAmount) / 100, values);
      const processed = transformed.secondaryApplied
        ? transformed.data
        : processPixels(transformed.data, size.width, size.height, values);
      data.data.set(processed);
      sourceContext.putImageData(data, 0, 0);
    }
    return transformCanvas(sourceCanvas, values);
  }

  function drawCanvas(destination, source) {
    if (!source) return;
    destination.width = source.width;
    destination.height = source.height;
    const destinationContext = destination.getContext("2d");
    destinationContext.clearRect(0, 0, destination.width, destination.height);
    destinationContext.drawImage(source, 0, 0);
  }

  function fitCanvasToStage() {
    if (!canvas.width || !canvas.height) return;
    const stageStyle = window.getComputedStyle(stage);
    const horizontalPadding = parseFloat(stageStyle.paddingLeft || 0) + parseFloat(stageStyle.paddingRight || 0);
    const verticalPadding = parseFloat(stageStyle.paddingTop || 0) + parseFloat(stageStyle.paddingBottom || 0);
    const availableWidth = Math.max(1, stage.clientWidth - horizontalPadding);
    const availableHeight = Math.max(1, stage.clientHeight - verticalPadding);
    const fitScale = Math.min(1, availableWidth / canvas.width, availableHeight / canvas.height);
    // Give the DOM canvas an explicit contained box.  Relying only on
    // max-width/max-height leaves tall RAW frames vulnerable to a transformed
    // intrinsic size being clipped on narrow/mobile stages.
    const cssWidth = Math.max(1, Math.floor(canvas.width * fitScale));
    const cssHeight = Math.max(1, Math.floor(canvas.height * fitScale));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    if (compareCanvas && compareCanvas.width && compareCanvas.height) {
      const compareScale = Math.min(1, availableWidth / compareCanvas.width, availableHeight / compareCanvas.height);
      compareCanvas.style.width = `${Math.max(1, Math.floor(compareCanvas.width * compareScale))}px`;
      compareCanvas.style.height = `${Math.max(1, Math.floor(compareCanvas.height * compareScale))}px`;
    }
  }

  function updateHistogram(source) {
    if (!source || !histogramBars.length || !source.width || !source.height) return;
    try {
      const data = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, source.width, source.height).data;
      const bins = new Array(histogramBars.length).fill(0);
      const pixelCount = source.width * source.height;
      const stride = Math.max(1, Math.ceil(pixelCount / 180000));
      for (let pixel = 0; pixel < pixelCount; pixel += stride) {
        const index = pixel * 4;
        const luminance = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
        bins[Math.min(bins.length - 1, Math.floor(luminance * bins.length))] += 1;
      }
      const peak = Math.max(1, ...bins);
      histogramBars.forEach((bar, index) => {
        bar.style.height = `${Math.max(6, Math.round((bins[index] / peak) * 100))}%`;
      });
    } catch {
      // The canvas may be unavailable briefly while an image is replaced.
    }
  }

  function ensureCompareCanvas() {
    if (compareCanvas) return compareCanvas;
    compareCanvas = document.createElement("canvas");
    compareCanvas.id = "compareCanvas";
    compareCanvas.setAttribute("aria-hidden", "true");
    compareCanvas.style.cssText = "position:absolute; max-width:100%; max-height:100%; border-radius:2px; box-shadow:0 24px 70px #0008; pointer-events:none;";
    stage.insertBefore(compareCanvas, canvas);
    return compareCanvas;
  }

  function defaultCropRect() {
    if (!canvas.width || !canvas.height || state.aspect === "free") return { x: 0, y: 0, width: 1, height: 1 };
    const targetRatio = Number(state.aspect);
    const sourceRatio = canvas.width / canvas.height;
    if (!Number.isFinite(targetRatio) || targetRatio <= 0) return { x: 0, y: 0, width: 1, height: 1 };
    if (sourceRatio > targetRatio) {
      const width = targetRatio / sourceRatio;
      return { x: (1 - width) / 2, y: 0, width, height: 1 };
    }
    const height = sourceRatio / targetRatio;
    return { x: 0, y: (1 - height) / 2, width: 1, height };
  }

  function cropRectFromDrag(startX, startY, endX, endY) {
    const dx = endX - startX;
    const dy = endY - startY;
    let width = Math.max(0.02, Math.abs(dx));
    let height = Math.max(0.02, Math.abs(dy));
    const targetRatio = state.aspect === "free" ? null : Number(state.aspect);
    if (Number.isFinite(targetRatio) && targetRatio > 0) {
      if (width / height > targetRatio) height = width / targetRatio;
      else width = height * targetRatio;
    }
    let x = dx < 0 ? startX - width : startX;
    let y = dy < 0 ? startY - height : startY;
    x = Math.max(0, Math.min(1 - width, x));
    y = Math.max(0, Math.min(1 - height, y));
    if (width > 1) { width = 1; x = 0; }
    if (height > 1) { height = 1; y = 0; }
    return { x, y, width, height };
  }

  function updateCropOverlay() {
    if (!cropOverlay || !cropSelection) return;
    const visible = state.mode === "crop" && state.imageLoaded && canvas.classList.contains("ready") && canvas.width > 0 && canvas.height > 0;
    if (!visible) {
      cropOverlay.classList.add("hidden");
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if (canvasRect.width < 1 || canvasRect.height < 1) {
      cropOverlay.classList.add("hidden");
      return;
    }
    cropOverlay.classList.remove("hidden");
    cropOverlay.style.left = `${canvasRect.left - stageRect.left}px`;
    cropOverlay.style.top = `${canvasRect.top - stageRect.top}px`;
    cropOverlay.style.width = `${canvasRect.width}px`;
    cropOverlay.style.height = `${canvasRect.height}px`;
    const rect = state.cropRect || defaultCropRect();
    cropSelection.style.left = `${Math.max(0, Math.min(1, rect.x)) * 100}%`;
    cropSelection.style.top = `${Math.max(0, Math.min(1, rect.y)) * 100}%`;
    cropSelection.style.width = `${Math.max(0.01, Math.min(1, rect.width)) * 100}%`;
    cropSelection.style.height = `${Math.max(0.01, Math.min(1, rect.height)) * 100}%`;
  }

  function cropPointerPosition(event) {
    const rect = cropOverlay.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  function render() {
    if (!state.imageLoaded || !state.image) {
      canvas.classList.remove("ready");
      emptyState.classList.remove("hidden");
      renderStatus.textContent = "等待图片";
      updateCropOverlay();
      return;
    }
    emptyState.classList.add("hidden");
    canvas.classList.add("ready");
    const token = ++renderToken;
    renderStatus.textContent = "正在渲染 · 多核处理";
    window.requestAnimationFrame(async () => {
      if (token !== renderToken) return;
      try {
        const after = await makeProcessedCanvas(false);
        const before = state.before || state.compare ? await makeProcessedCanvas(true) : null;
        if (token !== renderToken) return;
        drawCanvas(canvas, state.before ? before : after);
        updateHistogram(canvas);
        if (state.compare) {
          drawCanvas(ensureCompareCanvas(), before);
          compareCanvas.classList.remove("hidden");
          canvas.classList.add("compare-active");
          compareLine.classList.remove("hidden");
        } else if (compareCanvas) {
          compareCanvas.classList.add("hidden");
          canvas.classList.remove("compare-active");
          compareLine.classList.add("hidden");
        }
        canvas.style.transform = `scale(${state.zoom})`;
        compareCanvas?.style.setProperty("transform", `scale(${state.zoom})`);
        fitCanvasToStage();
        canvas.style.border = "0";
        canvas.style.padding = "0";
        lastCanvasSize = { width: canvas.width, height: canvas.height };
        renderStatus.textContent = `${canvas.width} × ${canvas.height} · ${activeFilmLabel.textContent}`;
        updateCropOverlay();
      } catch (error) {
        if (token === renderToken) renderStatus.textContent = "渲染失败 · 请重试";
        console.error(error);
      }
    });
  }

  function showToast(message) {
    stageToast.textContent = message;
    stageToast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => stageToast.classList.remove("show"), 1800);
  }

  function handleFieldChange(control, commit = true) {
    const key = control.dataset.field;
    if (!key) return;
    if (control.type === "range") {
      if (control.dataset.historyPushed !== "true") {
        pushHistory();
        control.dataset.historyPushed = "true";
      }
      if (commit) control.dataset.historyPushed = "false";
    } else if (commit) {
      pushHistory();
    }
    state[key] = control.type === "range" ? Number(control.value) : control.value;
    if (key === "aspect") state.cropRect = null;
    if (key === "frameStyle" && Number(state.frameSize) <= 0) {
      state.frameSize = 8;
      const frameSizeControl = $("#frameSize");
      const frameSizeOutput = $('[data-output="frameSize"]');
      if (frameSizeControl) frameSizeControl.value = "8";
      if (frameSizeOutput) frameSizeOutput.textContent = formatValue("frameSize", 8);
    }
    const output = $(`[data-output="${key}"]`);
    if (output) output.textContent = formatValue(key, state[key]);
    render();
  }

  function classifyEmbeddedProfile(bytes) {
    if (!bytes || !bytes.length) return null;
    // ICC profile descriptions are ASCII/UTF-16 payloads.  latin1 keeps the
    // byte-to-character mapping stable and avoids UTF-8 replacement glyphs
    // hiding a description in an otherwise binary image header.
    const text = new TextDecoder("latin1").decode(bytes);
    if (/Adobe\s*RGB\s*\(1998\)|Adobe\s*RGB/i.test(text)) return "adobe-rgb";
    if (/Display\s*P3|DisplayP3|P3\s*D65/i.test(text)) return "display-p3";
    if (/ProPhoto|ROMM\s*RGB|ROMM_RGB/i.test(text)) return "prophoto-rgb";
    if (/Rec\.?\s*2020|BT\.?\s*2020|ITU[-_ ]R\s*BT\.2020/i.test(text)) return "rec2020";
    return null;
  }

  function jpegIccProfile(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const chunks = [];
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break; // image data follows
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      if (marker === 0xe2) {
        const payloadStart = offset + 2;
        const payloadEnd = offset + length;
        const signature = "ICC_PROFILE\0";
        let matches = true;
        for (let index = 0; index < signature.length; index += 1) {
          if (bytes[payloadStart + index] !== signature.charCodeAt(index)) { matches = false; break; }
        }
        if (matches && payloadStart + 14 <= payloadEnd) {
          chunks.push({ sequence: bytes[payloadStart + 12], total: bytes[payloadStart + 13], data: bytes.slice(payloadStart + 14, payloadEnd) });
        }
      }
      offset += length;
    }
    if (!chunks.length) return null;
    chunks.sort((a, b) => a.sequence - b.sequence);
    const total = chunks[0].total;
    if (!total || chunks.length < total) return null;
    const profile = [];
    for (let sequence = 1; sequence <= total; sequence += 1) {
      const chunk = chunks.find((item) => item.sequence === sequence);
      if (!chunk) return null;
      profile.push(chunk.data);
    }
    const length = profile.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(length);
    let cursor = 0;
    profile.forEach((chunk) => { output.set(chunk, cursor); cursor += chunk.length; });
    return output;
  }

  function pngIccProfileName(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = (((bytes[offset] << 24) >>> 0) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const start = offset + 8;
      const end = start + length;
      if (end + 4 > bytes.length) break;
      if (type === "iCCP") {
        const zero = bytes.indexOf(0, start);
        if (zero > start) return bytes.slice(start, zero);
      }
      offset = end + 4;
      if (type === "IEND") break;
    }
    return null;
  }

  function tiffIccProfile(bytes) {
    if (bytes.length < 16) return null;
    const little = bytes[0] === 0x49 && bytes[1] === 0x49;
    const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
    if (!little && !big) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (offset) => view.getUint16(offset, little);
    const u32 = (offset) => view.getUint32(offset, little);
    if (u16(2) !== 42) return null;
    const ifd = u32(4);
    if (ifd + 2 > bytes.length) return null;
    const count = u16(ifd);
    const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    for (let index = 0; index < count; index += 1) {
      const entry = ifd + 2 + index * 12;
      if (entry + 12 > bytes.length) break;
      const tag = u16(entry);
      if (tag !== 34675) continue; // InterColorProfile
      const type = u16(entry + 2);
      const itemSize = typeSize[type];
      const itemCount = u32(entry + 4);
      if (!itemSize || !itemCount || itemCount > bytes.length) return null;
      const length = itemSize * itemCount;
      const start = length <= 4 ? entry + 8 : u32(entry + 8);
      if (start < 0 || start + length > bytes.length) return null;
      return bytes.slice(start, start + length);
    }
    return null;
  }

  function detectInputColorSpaceFromBytes(bytes) {
    const profile = jpegIccProfile(bytes) || tiffIccProfile(bytes) || pngIccProfileName(bytes);
    return classifyEmbeddedProfile(profile || bytes) || "srgb";
  }

  async function detectInputColorSpace(file) {
    try {
      // ICC data is normally in the JPEG/TIFF/PNG header.  A bounded read
      // keeps a large photo or RAW preview from being copied just for profile
      // detection; uncompressed 16-bit TIFFs pass their already-read bytes to
      // detectInputColorSpaceFromBytes below.
      const header = new Uint8Array(await file.slice(0, 8 * 1048576).arrayBuffer());
      return detectInputColorSpaceFromBytes(header);
    } catch { /* use the safe sRGB default */ }
    return "srgb";
  }

  function acceptImage(image, colorSpace, token, url = "") {
    if (token !== imageLoadToken) {
      image.close?.();
      if (url) URL.revokeObjectURL(url);
      return;
    }
    if (state.image?.close) state.image.close();
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.image = image;
    state.rawImage = null;
    state.deepImage = null;
    state.imageUrl = url;
    state.imageColorSpace = colorSpace;
    // JPG/PNG/TIFF are already rendered/output-referred. Applying ACR3 here
    // would double-apply the base tone curve before the Creative RGBTable.
    state.imageApplyAcr3 = false;
    state.imageBitDepth = 8;
    state.imageName = "";
    state.imageLoaded = true;
    state.imageLabel = "已载入图片";
    state.zoom = 1;
    syncControls();
    render();
    showToast("图片已载入");
  }

  const rawExtensions = /\.(dng|nef|nrw|cr2|cr3|arw|srf|sr2|raf|rw2|orf|pef|srw|3fr|iiq|x3f|raw)$/i;

  function isRawFile(file) {
    return Boolean(file && rawExtensions.test(file.name || ""));
  }

  async function decodeUncompressedTiff16(file) {
    if (!/\.tiff?$/i.test(file.name || "")) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length < 16) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = bytes[0] === 0x49 && bytes[1] === 0x49;
    if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return null;
    const u16 = (offset) => view.getUint16(offset, little);
    const u32 = (offset) => view.getUint32(offset, little);
    if (u16(2) !== 42) return null; // BigTIFF/compressed inputs fall back to browser decoding.
    const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    const readValues = (entryOffset) => {
      const type = u16(entryOffset + 2);
      const count = u32(entryOffset + 4);
      const unit = typeSize[type];
      if (!unit || count > 1000000) return [];
      const length = unit * count;
      const base = length <= 4 ? entryOffset + 8 : u32(entryOffset + 8);
      if (base < 0 || base + length > bytes.length) return [];
      const values = [];
      for (let i = 0; i < count; i += 1) {
        const offset = base + i * unit;
        if (type === 1 || type === 7) values.push(bytes[offset]);
        else if (type === 3) values.push(u16(offset));
        else if (type === 4) values.push(u32(offset));
        else if (type === 8) values.push(view.getInt16(offset, little));
        else if (type === 9) values.push(view.getInt32(offset, little));
        else values.push(0);
      }
      return values;
    };
    const ifdOffset = u32(4);
    if (ifdOffset + 2 > bytes.length) return null;
    const count = u16(ifdOffset);
    const tags = new Map();
    for (let i = 0; i < count; i += 1) {
      const at = ifdOffset + 2 + i * 12;
      if (at + 12 > bytes.length) break;
      tags.set(u16(at), readValues(at));
    }
    const width = tags.get(256)?.[0];
    const height = tags.get(257)?.[0];
    const bits = tags.get(258) || [];
    const compression = tags.get(259)?.[0] || 1;
    const photometric = tags.get(262)?.[0] || 2;
    const offsets = tags.get(273) || [];
    const samples = tags.get(277)?.[0] || bits.length || 3;
    const rowsPerStrip = tags.get(278)?.[0] || height;
    const byteCounts = tags.get(279) || [];
    const planar = tags.get(284)?.[0] || 1;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width * height > 120000000 || compression !== 1 || photometric !== 2
      || planar !== 1 || samples < 3 || samples > 4 || bits.some((value) => value !== 16)) return null;
    const output = new Uint16Array(width * height * 4);
    let destinationRow = 0;
    for (let strip = 0; strip < offsets.length && destinationRow < height; strip += 1) {
      const offset = offsets[strip];
      const byteCount = byteCounts[strip] || 0;
      if (offset < 0 || byteCount < width * 2 * samples || offset + byteCount > bytes.length) return null;
      const rows = Math.min(rowsPerStrip, height - destinationRow);
      const rowBytes = width * samples * 2;
      for (let row = 0; row < rows; row += 1) {
        const sourceRow = offset + row * rowBytes;
        const targetRow = (destinationRow + row) * width * 4;
        for (let x = 0; x < width; x += 1) {
          const sourcePixel = sourceRow + x * samples * 2;
          const targetPixel = targetRow + x * 4;
          output[targetPixel] = u16(sourcePixel);
          output[targetPixel + 1] = u16(sourcePixel + 2);
          output[targetPixel + 2] = u16(sourcePixel + 4);
          output[targetPixel + 3] = samples > 3 ? u16(sourcePixel + 6) : 65535;
        }
      }
      destinationRow += rows;
    }
    if (destinationRow < height) return null;
    return { width, height, data: output, colorSpace: detectInputColorSpaceFromBytes(bytes) };
  }

  function setDeepImage(decoded, file, token) {
    if (token !== imageLoadToken) return;
    state.image?.close?.();
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.image = { naturalWidth: decoded.width, naturalHeight: decoded.height, width: decoded.width, height: decoded.height };
    state.deepImage = decoded;
    state.rawImage = null;
    state.imageUrl = "";
    state.imageColorSpace = decoded.colorSpace || "srgb";
    state.imageApplyAcr3 = false;
    state.imageBitDepth = 16;
    state.imageName = file.name || "TIFF";
    state.imageLoaded = true;
    state.imageLabel = file.name || "TIFF";
    state.zoom = 1;
    syncControls();
    render();
    showToast(`16 位 TIFF 已载入 · ${decoded.width} × ${decoded.height}`);
    generateFilmPreviews();
  }

  function decodeRawFile(file, token) {
    return new Promise((resolve, reject) => {
      if (token !== imageLoadToken) return reject(new DOMException("Import cancelled.", "AbortError"));
      const worker = new Worker("raw-worker.js", { type: "module" });
      let settled = false;
      let timeout = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        worker.terminate();
        error ? reject(error) : resolve(value);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish(new Error("RAW 解码器无法运行"));
      };
      worker.onmessage = ({ data }) => {
        if (token !== imageLoadToken) return finish(new DOMException("Import cancelled.", "AbortError"));
        if (data.status) {
          renderStatus.textContent = data.status;
          return;
        }
        if (data.error) return finish(new Error(data.error));
        if (!(data.pixels instanceof Uint16Array) || ![1, 3].includes(data.colors)
          || !Number.isInteger(data.width) || !Number.isInteger(data.height)
          || data.width < 1 || data.height < 1
          || data.pixels.length !== data.width * data.height * data.colors) {
          return finish(new Error("RAW 解码器返回了无效像素"));
        }
        finish(null, data);
      };
      file.arrayBuffer().then((bytes) => {
        if (token === imageLoadToken && !settled) {
          const decoderURL = new URL("raw/decoder.mjs", document.baseURI).href;
          worker.postMessage({ bytes, negative: false, decoderURL }, [bytes]);
        }
      }).catch((error) => finish(error));
      timeout = setTimeout(() => finish(new Error("RAW 解码超时，请尝试较小的文件")), 180000);
    });
  }

  function setRawImage(decoded, file, token) {
    if (token !== imageLoadToken) return;
    state.image?.close?.();
    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.image = { naturalWidth: decoded.width, naturalHeight: decoded.height, width: decoded.width, height: decoded.height };
    state.deepImage = null;
    state.rawImage = {
      width: decoded.width,
      height: decoded.height,
      colors: decoded.colors,
      data: decoded.pixels,
      sceneScale: Number.isFinite(decoded.sceneScale) && decoded.sceneScale > 0 ? decoded.sceneScale : 1,
      profile: decoded.profile,
      sceneKelvin: decoded.sceneKelvin,
    };
    state.imageUrl = "";
    state.imageColorSpace = "rec2020-linear";
    state.imageApplyAcr3 = true;
    state.imageBitDepth = 16;
    state.imageName = file.name || "RAW";
    state.imageLoaded = true;
    state.imageLabel = file.name || "RAW";
    state.zoom = 1;
    syncControls();
    render();
    showToast(`RAW 已载入 · 16 位管线 · ${decoded.width} × ${decoded.height}`);
    generateFilmPreviews();
  }

  async function loadFile(file) {
    if (!file || !file.type.startsWith("image/") && !/\.tiff?$/i.test(file.name) && !isRawFile(file)) return showToast("请选择图片或 RAW 文件");
    const token = ++imageLoadToken;
    if (isRawFile(file)) {
      try {
        renderStatus.textContent = "正在解码 RAW · 16 位管线";
        const decoded = await decodeRawFile(file, token);
        setRawImage(decoded, file, token);
      } catch (error) {
        if (token === imageLoadToken) {
          renderStatus.textContent = "RAW 解码失败";
          showToast(error?.message || "RAW 文件无法读取");
        }
      }
      return;
    }
    if (/\.tiff?$/i.test(file.name || "")) {
      try {
        const decoded = await decodeUncompressedTiff16(file);
        if (decoded) {
          setDeepImage(decoded, file, token);
          return;
        }
      } catch (error) {
        console.warn("16-bit TIFF parser fallback", error);
      }
    }
    const colorSpace = await detectInputColorSpace(file);
    if (typeof window.createImageBitmap === "function") {
      try {
        // Preserve embedded Adobe RGB values. The following matrix conversion
        // is performed explicitly before the ProPhoto/ACR LUT path.
        const image = await window.createImageBitmap(file, { colorSpaceConversion: "none" });
        acceptImage(image, colorSpace, token);
        generateFilmPreviews();
        return;
      } catch { /* fall through to the compatibility Image decoder */ }
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { acceptImage(image, "srgb", token, url); generateFilmPreviews(); };
    image.onerror = () => { URL.revokeObjectURL(url); showToast("图片无法读取"); };
    image.src = url;
  }

  async function exportImage() {
    if (!state.imageLoaded) return showToast("请先打开一张图片");
    renderStatus.textContent = "正在生成高清导出 · 多核处理";
    let source;
    try {
      source = await makeProcessedCanvas(false, { fullResolution: true });
    } catch (error) {
      console.error("high-resolution export", error);
      renderStatus.textContent = "高清导出失败";
      return showToast("高清导出失败，请尝试较小的原图");
    }
    if (!source) {
      renderStatus.textContent = "高清导出失败";
      return showToast("导出失败");
    }
    const type = state.outputFormat || "image/jpeg";
    const quality = Number(state.quality) / 100;
    if (type === "image/tiff") {
      try {
        const blob = encodeTiff16(source);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `film-whisper-${Date.now()}.tif`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        renderStatus.textContent = `${source.width} × ${source.height} · 已导出`;
        showToast("16 位 TIFF 已导出");
      } catch (error) {
        console.error(error);
        showToast("TIFF 导出失败");
      }
      return;
    }
    source.toBlob((blob) => {
      if (!blob) return showToast("导出失败");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const extension = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      anchor.href = url;
      anchor.download = `film-whisper-${Date.now()}.${extension}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      renderStatus.textContent = `${source.width} × ${source.height} · 已导出`;
      showToast("文件已导出");
    }, type, quality);
  }

  function encodeTiff16(source) {
    const width = source.width;
    const height = source.height;
    const pixels = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    const entryCount = 10;
    const bitsOffset = 8 + 2 + entryCount * 12 + 4;
    const stripOffset = bitsOffset + 6;
    const byteCount = width * height * 3 * 2;
    const buffer = new ArrayBuffer(stripOffset + byteCount);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    bytes[0] = 0x49; bytes[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, entryCount, true);
    let entry = 10;
    const writeEntry = (tag, type, count, value) => {
      view.setUint16(entry, tag, true);
      view.setUint16(entry + 2, type, true);
      view.setUint32(entry + 4, count, true);
      if (type === 3 && count === 1) view.setUint16(entry + 8, value, true);
      else view.setUint32(entry + 8, value, true);
      entry += 12;
    };
    writeEntry(256, 4, 1, width);
    writeEntry(257, 4, 1, height);
    writeEntry(258, 3, 3, bitsOffset);
    writeEntry(259, 3, 1, 1);
    writeEntry(262, 3, 1, 2);
    writeEntry(273, 4, 1, stripOffset);
    writeEntry(277, 3, 1, 3);
    writeEntry(278, 4, 1, height);
    writeEntry(279, 4, 1, byteCount);
    writeEntry(284, 3, 1, 1);
    view.setUint32(entry, 0, true);
    view.setUint16(bitsOffset, 16, true);
    view.setUint16(bitsOffset + 2, 16, true);
    view.setUint16(bitsOffset + 4, 16, true);
    let at = stripOffset;
    for (let i = 0; i < pixels.length; i += 4) {
      view.setUint16(at, pixels[i] * 257, true);
      view.setUint16(at + 2, pixels[i + 1] * 257, true);
      view.setUint16(at + 4, pixels[i + 2] * 257, true);
      at += 6;
    }
    return new Blob([buffer], { type: "image/tiff" });
  }

  function saveSettings() {
    localStorage.setItem("filmwhisper-settings", JSON.stringify(snapshot()));
    showToast("设置已保存到本机");
  }

  function loadSettings() {
    const stored = localStorage.getItem("filmwhisper-settings");
    if (!stored) return showToast("还没有保存的设置");
    try {
      pushHistory();
      restore(JSON.parse(stored));
      showToast("已载入设置");
    } catch { showToast("保存的设置无法读取"); }
  }

  function toggleFavorite(id = state.selectedFilm) {
    const film = filmPresets.find((item) => item.id === id);
    if (!film) return showToast("没有可收藏的胶片");
    const index = state.savedFilms.indexOf(id);
    if (index === -1) state.savedFilms.push(id);
    else state.savedFilms.splice(index, 1);
    try {
      localStorage.setItem("filmwhisper-saved", JSON.stringify(state.savedFilms));
    } catch {
      // Keep the in-memory collection usable when storage is blocked.
    }
    syncControls();
    renderFilmCards();
    showToast(index === -1 ? `${film.name} 已加入收藏` : `${film.name} 已取消收藏`);
  }

  function setMode(mode) {
    state.mode = mode;
    state.mobileNav = mode;
    const modeNames = { develop: "调整", print: "输出", crop: "裁剪" };
    if (mode === "print") openSections(["screen", "frame", "output"]);
    if (mode === "crop") openSections(["crop"]);
    syncControls();
    showToast(`${modeNames[mode] || "调整"}模式`);
  }

  function openSections(names) {
    names.forEach((name) => $(`[data-section="${name}"]`)?.classList.add("open"));
  }

  function action(name) {
    switch (name) {
      case "open": fileInput.click(); break;
      case "export": exportImage(); break;
      case "undo": undo(); break;
      case "redo": redo(); break;
      case "reset": resetAll(); break;
      case "before": state.before = !state.before; render(); showToast(state.before ? "正在查看原图" : "返回编辑结果"); break;
      case "compare": state.compare = !state.compare; render(); showToast(state.compare ? "已开启前后对比" : "已关闭前后对比"); break;
      case "save": saveSettings(); break;
      case "load": loadSettings(); break;
      case "zoom-in": state.zoom = Math.min(2.5, state.zoom + 0.25); syncControls(); render(); break;
      case "zoom-out": state.zoom = Math.max(0.5, state.zoom - 0.25); syncControls(); render(); break;
      case "fit": state.zoom = 1; syncControls(); render(); showToast("已适合画布"); break;
      case "reset-crop":
        pushHistory();
        state.cropRect = null;
        syncControls();
        render();
        showToast("已重置裁剪区域");
        break;
      case "rotate-left": pushHistory(); state.rotation = (state.rotation + 270) % 360; render(); break;
      case "rotate-right": pushHistory(); state.rotation = (state.rotation + 90) % 360; render(); break;
      case "flip-h": pushHistory(); state.flipH = !state.flipH; render(); break;
      case "favorite": toggleFavorite(); break;
      case "fullscreen": document.documentElement.requestFullscreen?.(); break;
      case "toggle-left":
        shell.classList.toggle("left-open");
        if (shell.classList.contains("left-open")) {
          state.mobileNav = "films";
          syncControls();
        }
        break;
      case "toggle-right": shell.classList.toggle("right-open"); break;
      case "close-drawers": shell.classList.remove("left-open", "right-open"); break;
      default: showToast("功能已准备");
    }
  }

  $$("[data-action]").forEach((button) => button.addEventListener("click", () => action(button.dataset.action)));
  $$("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $$(".section-heading").forEach((heading) => heading.addEventListener("click", () => heading.parentElement.classList.toggle("open")));
  $$('[data-field]').forEach((control) => {
    control.addEventListener("input", () => handleFieldChange(control, false));
    control.addEventListener("change", () => handleFieldChange(control, true));
  });
  $$('[data-mobile-nav]').forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.mobileNav;
    if (target === "films") {
      state.mobileNav = "films";
      syncControls();
      shell.classList.remove("right-open");
      shell.classList.add("left-open");
      return;
    }
    shell.classList.remove("left-open");
    shell.classList.add("right-open");
    setMode(target);
  }));
  $$("[data-library-tab]").forEach((tab) => tab.addEventListener("click", () => {
    $$('[data-library-tab]').forEach((item) => item.classList.toggle("active", item === tab));
    const target = tab.dataset.libraryTab;
    filmGrid.classList.toggle("hidden", target !== "films");
    historyList.classList.toggle("hidden", target !== "history");
    savedList.classList.toggle("hidden", target !== "saved");
  }));
  filmSearch.addEventListener("input", renderFilmCards);
  fileInput.addEventListener("change", () => loadFile(fileInput.files?.[0]));
  stage.addEventListener("dragover", (event) => { event.preventDefault(); stage.classList.add("dragging"); });
  stage.addEventListener("dragleave", () => stage.classList.remove("dragging"));
  stage.addEventListener("drop", (event) => { event.preventDefault(); stage.classList.remove("dragging"); loadFile(event.dataTransfer.files?.[0]); });
  cropOverlay?.addEventListener("pointerdown", (event) => {
    if (state.mode !== "crop" || !state.imageLoaded) return;
    const position = cropPointerPosition(event);
    pushHistory();
    cropPointer = { pointerId: event.pointerId, startX: position.x, startY: position.y };
    state.cropRect = cropRectFromDrag(position.x, position.y, position.x, position.y);
    cropOverlay.setPointerCapture?.(event.pointerId);
    updateCropOverlay();
    event.preventDefault();
  });
  cropOverlay?.addEventListener("pointermove", (event) => {
    if (!cropPointer || cropPointer.pointerId !== event.pointerId) return;
    const position = cropPointerPosition(event);
    state.cropRect = cropRectFromDrag(cropPointer.startX, cropPointer.startY, position.x, position.y);
    updateCropOverlay();
    event.preventDefault();
  });
  const finishCropPointer = (event) => {
    if (!cropPointer || cropPointer.pointerId !== event.pointerId) return;
    cropOverlay.releasePointerCapture?.(event.pointerId);
    cropPointer = null;
    render();
    showToast("裁剪区域已更新");
  };
  cropOverlay?.addEventListener("pointerup", finishCropPointer);
  cropOverlay?.addEventListener("pointercancel", finishCropPointer);
  $("#themeToggle").addEventListener("click", () => { document.body.classList.toggle("light"); localStorage.setItem("filmwhisper-theme", document.body.classList.contains("light") ? "light" : "dark"); });
  $("#brandMenu").addEventListener("click", () => showToast("快捷键：O 打开 · Space 原图 · R 重置"));
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "o") { event.preventDefault(); fileInput.click(); }
    if (!event.ctrlKey && !event.metaKey && event.code === "Space" && state.imageLoaded) { event.preventDefault(); state.before = true; render(); }
    if (event.key === "Escape") { state.before = false; shell.classList.remove("left-open", "right-open"); render(); }
  });
  window.addEventListener("keyup", (event) => { if (event.code === "Space" && state.before) { state.before = false; render(); } });
  window.addEventListener("resize", () => { if (state.imageLoaded) render(); });

  state.history = [snapshot()];
  state.historyIndex = 0;
  if (localStorage.getItem("filmwhisper-theme") === "light") document.body.classList.add("light");
  syncControls();
  renderFilmCards();
  renderHistory();
  render();
})();
