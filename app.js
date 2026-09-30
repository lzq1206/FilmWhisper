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
  const renderStatus = $("#renderStatus");
  const zoomLabel = $("#zoomLabel");
  const stageToast = $("#stageToast");
  const compareLine = $("#compareLine");

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
    regionTarget: "Shadows",
    regionWarmth: 0,
    regionTint: 0,
    regionLevel: 0,
    gradeCurve: "Log",
    gradeContrast: 0,
    gradeSaturation: 0,
    negativeViewing: "Reference Exposure",
    viewingIlluminant: "D50",
    paperGrade: "Reference",
    screenExposure: 0,
    enlarger: "Diffuser",
    printerPreflash: 0,
    selectiveSubject: "Color",
    selectiveSpace: "RGB",
    selectiveFeather: 50,
    aspect: "free",
    filmFormat: "35mm",
    filter: "无",
    frameStyle: "无",
    outputFormat: "image/jpeg",
    quality: 92,
    outputMedium: "Photo",
  };

  const filmPresets = (Array.isArray(window.FILM_PROFILES) && window.FILM_PROFILES.length
    ? window.FILM_PROFILES
    : [{ id: "acros-100", name: "ACROS 100", meta: "色彩配置", swatch: "linear-gradient(135deg,#20242b,#8b6a58 48%,#d9b083)", index: 0 }])
    .map((profile) => ({ ...profile, values: {} }));
  const defaultFilmId = filmPresets[0]?.id || "acros-100";

  const state = {
    ...defaultValues,
    selectedFilm: defaultFilmId,
    mode: "develop",
    zoom: 1,
    before: false,
    compare: false,
    rotation: 0,
    flipH: false,
    image: null,
    imageUrl: "",
    imageLoaded: false,
    imageLabel: "",
    history: [],
    historyIndex: -1,
    savedFilms: JSON.parse(localStorage.getItem("filmwhisper-saved") || "[]")
      .filter((id) => filmPresets.some((film) => film.id === id)),
  };

  let renderToken = 0;
  let toastTimer;
  let compareCanvas = null;
  let lastCanvasSize = { width: 0, height: 0 };
  const lutConfig = window.FILM_LUT_CONFIG || null;
  const lutState = { buffer: null, size: lutConfig?.size || 32, count: lutConfig?.count || 0, ready: false, error: null };
  const lutReady = fetch("film-luts.bin")
    .then((response) => {
      if (!response.ok) throw new Error(`LUT asset ${response.status}`);
      return response.arrayBuffer();
    })
    .then((buffer) => {
      const view = new DataView(buffer);
      const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
      const size = view.getUint32(8, true);
      const count = view.getUint32(12, true);
      if (magic !== "FWLUT32\0" || size !== lutState.size || count !== filmPresets.length) {
        throw new Error("LUT asset header mismatch");
      }
      lutState.buffer = buffer;
      lutState.size = size;
      lutState.count = count;
      lutState.ready = true;
      if (state.imageLoaded) render();
      return buffer;
    })
    .catch((error) => {
      lutState.error = error;
      showToast("主配置资源暂时不可用");
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
    Object.assign(state, defaultValues, { selectedFilm: defaultFilmId, rotation: 0, flipH: false, before: false, compare: false });
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
    activeFilmLabel.textContent = filmPresets.find((film) => film.id === state.selectedFilm)?.name || filmPresets[0]?.name || "ACROS 100";
    zoomLabel.textContent = state.zoom === 1 ? "适合" : `${Math.round(state.zoom * 100)}%`;
    $("#mobileMode").textContent = ({ develop: "开发", print: "打印", crop: "裁剪" })[state.mode] || "开发";
    document.body.classList.toggle("before-mode", state.before);
  }

  function renderFilmCards() {
    const query = filmSearch.value.trim().toLowerCase();
    const filtered = filmPresets.filter((film) => `${film.name} ${film.meta}`.toLowerCase().includes(query));
    filmGrid.innerHTML = filtered.map((film) => `
      <button class="film-card ${state.selectedFilm === film.id ? "active" : ""}" data-film="${film.id}" style="--swatch:${film.swatch}" aria-label="选择 ${film.name}">
        <span class="film-card-preview" aria-hidden="true"><img src="film-previews/${film.id}.jpg" alt="" loading="lazy" decoding="async"></span>
        <span class="film-card-star">${state.savedFilms.includes(film.id) ? "★" : "☆"}</span>
        <span class="film-card-copy"><span class="film-card-name">${film.name}</span><span class="film-card-meta">${film.meta}</span></span>
      </button>`).join("");
    $$('[data-film]', filmGrid).forEach((card) => card.addEventListener("click", () => selectFilm(card.dataset.film)));
    renderSavedFilms();
  }

  function renderSavedFilms() {
    if (!state.savedFilms.length) {
      savedList.innerHTML = '<div class="history-item"><div><strong>还没有收藏</strong><span>在胶片卡片上点 ☆</span></div></div>';
      return;
    }
    savedList.innerHTML = state.savedFilms.map((id) => {
      const film = filmPresets.find((item) => item.id === id);
      return `<button class="saved-item" data-saved-film="${id}"><span><strong>${film?.name || id}</strong><span>${film?.meta || "色彩配置"}</span></span><span>★</span></button>`;
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
    const offset = lutConfig.headerBytes + profile.index * lutConfig.voxelBytes;
    return new Uint16Array(lutState.buffer, offset, lutState.size ** 3 * 3);
  }

  function applyPrimaryLut(source, amount = 1) {
    const lut = getPrimaryLut();
    if (!lut || !colorMatrices.srgbToXyz) return new Uint8ClampedArray(source);
    const output = new Uint8ClampedArray(source);
    const mix = clamp01(amount);
    for (let index = 0; index < source.length; index += 4) {
      const original = [source[index] / 255, source[index + 1] / 255, source[index + 2] / 255];
      const linearSrgb = original.map(srgbDecode);
      const xyzD65 = matrixVector(colorMatrices.srgbToXyz, linearSrgb);
      const xyzD50 = matrixVector(colorMatrices.d65ToD50, xyzD65);
      const proLinear = matrixVector(colorMatrices.xyzToProphoto, xyzD50);
      const proEncoded = proLinear.map((value) => clamp01(prophotoEncode(acr3Forward(value))));
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
        const worker = new Worker("pixel-worker.js");
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
      "halation", "vignette", "distortion", "filter", "selectedFilm",
    ];
    return fields.reduce((result, field) => {
      result[field] = values?.[field];
      return result;
    }, {});
  }

  function runLutWorkerChunks(source, width, height, amount, values) {
    const pool = getLutWorkerPool();
    const lut = getPrimaryLut();
    if (!pool || !lut || !colorMatrices.srgbToXyz) {
      return Promise.resolve({ data: applyPrimaryLut(source, amount), secondaryApplied: false });
    }
    const workerTotal = Math.min(pool.workers.length, Math.max(1, height));
    const rowsPerWorker = Math.ceil(height / workerTotal);
    const jobs = [];
    for (let workerIndex = 0; workerIndex < workerTotal; workerIndex += 1) {
      const startRow = workerIndex * rowsPerWorker;
      const endRow = Math.min(height, startRow + rowsPerWorker);
      if (startRow >= endRow) continue;
      const start = startRow * width * 4;
      const end = endRow * width * 4;
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
          buffer: chunk.buffer,
          lutBuffer,
        }, [chunk.buffer, lutBuffer]);
      }));
    }
    return Promise.all(jobs).then((chunks) => {
      const output = new Uint8ClampedArray(source);
      chunks.forEach((chunk) => output.set(new Uint8ClampedArray(chunk.buffer), chunk.startRow * width * 4));
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
        activeLutTask.resolve({ data: applyPrimaryLut(activeLutTask.source, activeLutTask.amount), secondaryApplied: false });
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
          const glow = ((lum - 0.64) / 0.36) * halation * 0.24;
          r += glow * 1.25;
          g += glow * 0.18;
          b -= glow * 0.15;
        }

        if (grainAmount > 0) {
          const gx = Math.floor(x / grainSize) * grainSize;
          const gy = Math.floor(y / grainSize) * grainSize;
          const noise = hashNoise(gx, gy, seed);
          const strength = grainAmount * (0.045 + Number(values.grainSize) / 100 * 0.055);
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
    const availableWidth = Math.max(240, stage.clientWidth - 50);
    const availableHeight = Math.max(200, stage.clientHeight - 50);
    const sourceRatio = state.image.naturalWidth / state.image.naturalHeight;
    let width = Math.min(availableWidth, state.image.naturalWidth);
    let height = width / sourceRatio;
    if (height > availableHeight) { height = availableHeight; width = height * sourceRatio; }
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
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
    let working = cropCanvas(source, values.aspect);
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
    if (Math.abs(Number(values.straighten)) > 0.01) {
      const rotated = document.createElement("canvas");
      rotated.width = output.width; rotated.height = output.height;
      const rctx = rotated.getContext("2d");
      rctx.translate(rotated.width / 2, rotated.height / 2);
      rctx.rotate((Number(values.straighten) * Math.PI) / 180);
      rctx.drawImage(output, -output.width / 2, -output.height / 2);
      return rotated;
    }
    return output;
  }

  async function makeProcessedCanvas(useBefore = false) {
    if (!state.imageLoaded || !state.image) return null;
    const size = fitSize();
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = size.width; sourceCanvas.height = size.height;
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    sourceContext.drawImage(state.image, 0, 0, size.width, size.height);
    const values = activeValues(useBefore);
    const data = sourceContext.getImageData(0, 0, size.width, size.height);
    const transformed = useBefore
      ? { data: new Uint8ClampedArray(data.data), secondaryApplied: false }
      : await applyPrimaryLutParallel(data.data, size.width, size.height, Number(values.filmAmount) / 100, values);
    const processed = transformed.secondaryApplied
      ? transformed.data
      : processPixels(transformed.data, size.width, size.height, values);
    data.data.set(processed);
    sourceContext.putImageData(data, 0, 0);
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

  function ensureCompareCanvas() {
    if (compareCanvas) return compareCanvas;
    compareCanvas = document.createElement("canvas");
    compareCanvas.id = "compareCanvas";
    compareCanvas.setAttribute("aria-hidden", "true");
    compareCanvas.style.cssText = "position:absolute; max-width:100%; max-height:100%; border-radius:2px; box-shadow:0 24px 70px #0008; pointer-events:none;";
    stage.insertBefore(compareCanvas, canvas);
    return compareCanvas;
  }

  function render() {
    if (!state.imageLoaded || !state.image) {
      canvas.classList.remove("ready");
      emptyState.classList.remove("hidden");
      renderStatus.textContent = "等待图片";
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
        if (state.frameStyle !== "无" && Number(state.frameSize) > 0) {
          canvas.style.border = `${Math.max(2, Number(state.frameSize) / 8)}px solid ${state.frameStyle.includes("White") ? "#f2eee4" : state.frameStyle.includes("Black") ? "#151515" : "#b89e7b"}`;
          canvas.style.padding = `${Math.max(0, Number(state.frameSize) / 12)}px`;
        } else {
          canvas.style.border = "0";
          canvas.style.padding = "0";
        }
        lastCanvasSize = { width: canvas.width, height: canvas.height };
        renderStatus.textContent = `${canvas.width} × ${canvas.height} · ${activeFilmLabel.textContent}`;
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
    const output = $(`[data-output="${key}"]`);
    if (output) output.textContent = formatValue(key, state[key]);
    render();
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith("image/") && !/\.tiff?$/i.test(file.name)) return showToast("请选择图片文件");
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
      state.image = image;
      state.imageUrl = url;
      state.imageLoaded = true;
      state.imageLabel = "已载入图片";
      state.zoom = 1;
      syncControls();
      render();
      showToast("图片已载入");
    };
    image.onerror = () => { URL.revokeObjectURL(url); showToast("图片无法读取"); };
    image.src = url;
  }

  async function exportImage() {
    if (!state.imageLoaded) return showToast("请先打开一张图片");
    const source = await makeProcessedCanvas(false);
    if (!source) return showToast("导出失败");
    const type = state.outputFormat || "image/jpeg";
    const quality = Number(state.quality) / 100;
    source.toBlob((blob) => {
      if (!blob) return showToast("导出失败");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const extension = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      anchor.href = url;
      anchor.download = `film-whisper-${Date.now()}.${extension}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("文件已导出");
    }, type, quality);
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

  function toggleFavorite() {
    const index = state.savedFilms.indexOf(state.selectedFilm);
    if (index === -1) state.savedFilms.push(state.selectedFilm);
    else state.savedFilms.splice(index, 1);
    localStorage.setItem("filmwhisper-saved", JSON.stringify(state.savedFilms));
    renderFilmCards();
    showToast(index === -1 ? "已加入收藏" : "已取消收藏");
  }

  function setMode(mode) {
    state.mode = mode;
    $$('.mode-tab').forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    const modeNames = { develop: "开发", print: "打印", crop: "裁剪" };
    $("#mobileMode").textContent = modeNames[mode] || "开发";
    if (mode === "print") openSections(["frame", "output"]);
    if (mode === "crop") openSections(["crop"]);
    showToast(`${modeNames[mode] || "开发"}模式`);
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
      case "rotate-left": pushHistory(); state.rotation = (state.rotation + 270) % 360; render(); break;
      case "rotate-right": pushHistory(); state.rotation = (state.rotation + 90) % 360; render(); break;
      case "flip-h": pushHistory(); state.flipH = !state.flipH; render(); break;
      case "favorite": toggleFavorite(); break;
      case "auto-levels": pushHistory(); state.exposure = 0.12; state.contrast = 8; state.highlights = -10; state.shadows = 12; syncControls(); render(); showToast("已自动平衡层次"); break;
      case "add-filter": showToast("已添加一个选择性滤镜"); break;
      case "fullscreen": document.documentElement.requestFullscreen?.(); break;
      case "toggle-left": shell.classList.toggle("left-open"); break;
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
  $("#themeToggle").addEventListener("click", () => { document.body.classList.toggle("light"); localStorage.setItem("filmwhisper-theme", document.body.classList.contains("light") ? "light" : "dark"); });
  $("#packButton").addEventListener("click", () => showToast("胶片包管理已打开本地模式"));
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
