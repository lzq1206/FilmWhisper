(() => {
  "use strict";

  const VERTEX_SOURCE = `#version 300 es
    in vec2 aPosition;
    out vec2 vUv;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SOURCE = `#version 300 es
    precision highp float;
    precision highp int;
    precision highp sampler2D;
    precision highp sampler3D;
    uniform sampler2D uSource;
    uniform sampler3D uAdapter;
    uniform sampler3D uFilm;
    uniform float uLutSize;
    uniform float uFilmAmount;
    uniform float uExposure;
    uniform float uPush;
    uniform float uScreenExposure;
    uniform float uContrast;
    uniform float uHighlights;
    uniform float uShadows;
    uniform float uTemperature;
    uniform float uTint;
    uniform float uSaturation;
    uniform float uVibrance;
    uniform float uBleach;
    uniform float uAge;
    uniform float uGrain;
    uniform float uGrainSize;
    uniform float uGrainColor;
    uniform float uVignette;
    uniform float uFilmFormatScale;
    uniform float uSeed;
    uniform mat3 uSrgbToXyz;
    uniform mat3 uD65ToD50;
    uniform mat3 uXyzToProphoto;
    uniform mat3 uProphotoToXyz;
    uniform mat3 uD50ToD65;
    uniform mat3 uXyzToSrgb;
    in vec2 vUv;
    out vec4 outColor;

    float srgbDecode(float value) {
      return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4);
    }

    float srgbEncode(float value) {
      float positive = max(0.0, value);
      return positive <= 0.0031308 ? 12.92 * positive : 1.055 * pow(positive, 1.0 / 2.4) - 0.055;
    }

    vec3 srgbDecode(vec3 value) { return vec3(srgbDecode(value.r), srgbDecode(value.g), srgbDecode(value.b)); }
    vec3 srgbEncode(vec3 value) { return vec3(srgbEncode(value.r), srgbEncode(value.g), srgbEncode(value.b)); }

    float prophotoEncode(float value) {
      float signValue = value < 0.0 ? -1.0 : 1.0;
      float magnitude = abs(value);
      return signValue * (magnitude < 1.0 / 512.0 ? magnitude * 16.0 : pow(magnitude, 1.0 / 1.8));
    }

    float prophotoDecode(float value) {
      float signValue = value < 0.0 ? -1.0 : 1.0;
      float magnitude = abs(value);
      return signValue * (magnitude < 16.0 / 512.0 ? magnitude / 16.0 : pow(magnitude, 1.8));
    }

    vec3 prophotoEncode(vec3 value) { return vec3(prophotoEncode(value.r), prophotoEncode(value.g), prophotoEncode(value.b)); }
    vec3 prophotoDecode(vec3 value) { return vec3(prophotoDecode(value.r), prophotoDecode(value.g), prophotoDecode(value.b)); }

    vec3 lutVoxel(sampler3D lut, ivec3 rgb) {
      return texelFetch(lut, ivec3(rgb.z, rgb.y, rgb.x), 0).rgb;
    }

    vec3 sampleLut(sampler3D lut, vec3 value) {
      vec3 position = clamp(value, 0.0, 1.0) * (uLutSize - 1.0);
      ivec3 low = ivec3(floor(position));
      ivec3 high = min(low + ivec3(1), ivec3(int(uLutSize) - 1));
      vec3 fraction = position - vec3(low);
      vec3 c000 = lutVoxel(lut, ivec3(low.x, low.y, low.z));
      vec3 c001 = lutVoxel(lut, ivec3(low.x, low.y, high.z));
      vec3 c010 = lutVoxel(lut, ivec3(low.x, high.y, low.z));
      vec3 c011 = lutVoxel(lut, ivec3(low.x, high.y, high.z));
      vec3 c100 = lutVoxel(lut, ivec3(high.x, low.y, low.z));
      vec3 c101 = lutVoxel(lut, ivec3(high.x, low.y, high.z));
      vec3 c110 = lutVoxel(lut, ivec3(high.x, high.y, low.z));
      vec3 c111 = lutVoxel(lut, ivec3(high.x, high.y, high.z));
      vec3 c00 = mix(c000, c001, fraction.z);
      vec3 c01 = mix(c010, c011, fraction.z);
      vec3 c10 = mix(c100, c101, fraction.z);
      vec3 c11 = mix(c110, c111, fraction.z);
      return mix(mix(c00, c01, fraction.y), mix(c10, c11, fraction.y), fraction.x);
    }

    vec3 rgbToHsl(vec3 rgb) {
      float maxValue = max(rgb.r, max(rgb.g, rgb.b));
      float minValue = min(rgb.r, min(rgb.g, rgb.b));
      float delta = maxValue - minValue;
      float hue = 0.0;
      float lightness = (maxValue + minValue) * 0.5;
      float saturation = delta == 0.0 ? 0.0 : delta / (1.0 - abs(2.0 * lightness - 1.0));
      if (delta != 0.0) {
        if (maxValue == rgb.r) hue = mod((rgb.g - rgb.b) / delta, 6.0);
        else if (maxValue == rgb.g) hue = (rgb.b - rgb.r) / delta + 2.0;
        else hue = (rgb.r - rgb.g) / delta + 4.0;
        hue /= 6.0;
        if (hue < 0.0) hue += 1.0;
      }
      return vec3(hue, saturation, lightness);
    }

    float hueToRgb(float hue) {
      float k = mod(hue * 12.0, 12.0);
      return max(-1.0, min(k - 3.0, min(9.0 - k, 1.0)));
    }

    vec3 hslToRgb(vec3 hsl) {
      if (hsl.y == 0.0) return vec3(hsl.z);
      float scale = hsl.y * min(hsl.z, 1.0 - hsl.z);
      return vec3(
        hsl.z - scale * hueToRgb(hsl.x),
        hsl.z - scale * hueToRgb(hsl.x + 8.0 / 12.0),
        hsl.z - scale * hueToRgb(hsl.x + 4.0 / 12.0)
      );
    }

    float hashNoise(vec2 point, float seed) {
      return fract(sin(dot(point + seed, vec2(12.9898, 78.233))) * 43758.5453) * 2.0 - 1.0;
    }

    void main() {
      vec4 sourceSample = texture(uSource, vUv);
      vec3 original = sourceSample.rgb;
      vec3 inputLinear = srgbDecode(original);
      vec3 xyzD65 = uSrgbToXyz * inputLinear;
      vec3 xyzD50 = uD65ToD50 * xyzD65;
      vec3 proLinear = uXyzToProphoto * xyzD50;
      vec3 encodedProphoto = clamp(prophotoEncode(proLinear), 0.0, 1.0);
      vec3 adapted = sampleLut(uAdapter, encodedProphoto);
      vec3 mappedPro = sampleLut(uFilm, adapted);
      vec3 mappedD50 = uProphotoToXyz * prophotoDecode(mappedPro);
      vec3 mappedD65 = uD50ToD65 * mappedD50;
      vec3 mapped = srgbEncode(clamp(uXyzToSrgb * mappedD65, 0.0, 1.0));
      vec3 rgb = mix(original, mapped, clamp(uFilmAmount, 0.0, 1.0));

      float exposure = pow(2.0, uExposure + uPush * 0.32 + uScreenExposure);
      rgb = srgbEncode(srgbDecode(rgb) * exposure);
      float contrast = max(0.0, uContrast);
      rgb = (rgb - 0.5) * contrast + 0.5;
      float luminance = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      float shadowMix = max(0.0, 0.55 - luminance) / 0.55;
      float highlightMix = max(0.0, luminance - 0.45) / 0.55;
      rgb += vec3(uShadows * shadowMix * 0.18 + uHighlights * highlightMix * 0.14);
      rgb.r += uTemperature * 0.11 + uTint * 0.035;
      rgb.g -= uTint * 0.08;
      rgb.b -= uTemperature * 0.11 - uTint * 0.035;

      vec3 hsl = rgbToHsl(max(rgb, vec3(0.0)));
      float vivid = hsl.y > 0.0001 ? (uVibrance >= 0.0 ? uVibrance * (1.0 - hsl.y) : uVibrance) : 0.0;
      rgb = hslToRgb(vec3(hsl.x, clamp(hsl.y * uSaturation + vivid, 0.0, 1.0), hsl.z));
      float gray = (rgb.r + rgb.g + rgb.b) / 3.0;
      rgb = mix(rgb, vec3(gray), uBleach * 0.52);
      rgb.r = rgb.r * (1.0 - uAge * 0.12) + uAge * 0.05;
      rgb.g = rgb.g * (1.0 - uAge * 0.16) + uAge * 0.035;
      rgb.b = rgb.b * (1.0 - uAge * 0.20) + uAge * 0.015;

      vec2 pixel = gl_FragCoord.xy;
      float edge = min(1.0, distance(vUv, vec2(0.5)) * 1.45);
      rgb *= 1.0 - uVignette * edge * edge * 0.65;
      if (uGrain > 0.0) {
        float block = max(1.0, uGrainSize / 12.0);
        vec2 grainPoint = floor(pixel / block) * block;
        float neutral = hashNoise(grainPoint, uSeed);
        float greenNoise = mix(neutral, hashNoise(grainPoint, uSeed + 17.0), uGrainColor);
        float blueNoise = mix(neutral, hashNoise(grainPoint, uSeed + 31.0), uGrainColor);
        float strength = uGrain * uFilmFormatScale * (0.045 + uGrainSize / 100.0 * 0.055);
        rgb += vec3(neutral, greenNoise, blueNoise) * strength;
      }
      outColor = vec4(clamp(rgb, 0.0, 1.0), sourceSample.a);
    }
  `;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "WebGL shader compilation failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram(gl) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "WebGL program linking failed";
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  function matrixData(matrix) {
    return new Float32Array([
      matrix[0][0], matrix[1][0], matrix[2][0],
      matrix[0][1], matrix[1][1], matrix[2][1],
      matrix[0][2], matrix[1][2], matrix[2][2],
    ]);
  }

  function create(canvas, config = {}) {
    if (!canvas || typeof canvas.getContext !== "function") return null;
    let gl;
    try { gl = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: false }); } catch { return null; }
    if (!gl || Number(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)) < (config.size || 32)) return null;
    let program;
    try { program = createProgram(gl); } catch (error) { console.warn("GPU preview unavailable", error); return null; }

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const sourceTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const lutTextures = { adapter: gl.createTexture(), film: gl.createTexture() };
    Object.values(lutTextures).forEach((texture) => {
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    });

    const locations = {};
    ["uLutSize", "uFilmAmount", "uExposure", "uPush", "uScreenExposure", "uContrast", "uHighlights", "uShadows", "uTemperature", "uTint", "uSaturation", "uVibrance", "uBleach", "uAge", "uGrain", "uGrainSize", "uGrainColor", "uVignette", "uFilmFormatScale", "uSeed", "uSrgbToXyz", "uD65ToD50", "uXyzToProphoto", "uProphotoToXyz", "uD50ToD65", "uXyzToSrgb"].forEach((name) => { locations[name] = gl.getUniformLocation(program, name); });
    locations.source = gl.getUniformLocation(program, "uSource");
    locations.adapter = gl.getUniformLocation(program, "uAdapter");
    locations.film = gl.getUniformLocation(program, "uFilm");

    const state = { sourceKey: null, adapterKey: null, filmKey: null, lost: false };
    const contextLost = () => { state.lost = true; };
    canvas.addEventListener("webglcontextlost", contextLost, false);

    function uploadLut(texture, key, data) {
      if (!data || !data.length) return false;
      const cacheKey = `${key}:${data.byteOffset}:${data.length}`;
      if (texture.__key === cacheKey) return true;
      const size = config.size || 32;
      const packed = new Uint8Array(size * size * size * 4);
      for (let index = 0; index < size * size * size; index += 1) {
        packed[index * 4] = Math.round(data[index * 3] / 257);
        packed[index * 4 + 1] = Math.round(data[index * 3 + 1] / 257);
        packed[index * 4 + 2] = Math.round(data[index * 3 + 2] / 257);
        packed[index * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, packed);
      if (gl.getError() !== gl.NO_ERROR) return false;
      texture.__key = cacheKey;
      return true;
    }

    function render(options = {}) {
      if (state.lost || !options.image || !options.filmLut || !options.adapter) return false;
      const width = Math.max(1, Math.round(options.width || options.image.width || options.image.naturalWidth));
      const height = Math.max(1, Math.round(options.height || options.image.height || options.image.naturalHeight));
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      if (state.sourceKey !== options.image) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, options.image);
        if (gl.getError() !== gl.NO_ERROR) return false;
        state.sourceKey = options.image;
      }
      if (!uploadLut(lutTextures.adapter, "adapter", options.adapter)) return false;
      if (!uploadLut(lutTextures.film, options.filmKey || "film", options.filmLut)) return false;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lutTextures.adapter);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, lutTextures.film);
      gl.uniform1i(locations.source, 0);
      gl.uniform1i(locations.adapter, 1);
      gl.uniform1i(locations.film, 2);
      const values = options.values || {};
      const set = (name, value) => gl.uniform1f(locations[name], Number(value) || 0);
      set("uLutSize", config.size || 32);
      set("uFilmAmount", Number(values.filmAmount) / 100);
      set("uExposure", values.exposure);
      set("uPush", values.push);
      set("uScreenExposure", values.screenExposure);
      set("uContrast", 1 + Number(values.contrast || 0) / 100);
      set("uHighlights", Number(values.highlights || 0) / 100);
      set("uShadows", Number(values.shadows || 0) / 100);
      set("uTemperature", Number(values.temperature || 0) / 100);
      set("uTint", Number(values.tint || 0) / 100);
      set("uSaturation", 1 + Number(values.saturation || 0) / 100);
      set("uVibrance", Number(values.vibrance || 0) / 100);
      set("uBleach", Number(values.bleach || 0) / 100);
      set("uAge", Number(values.age || 0) / 50);
      set("uGrain", Number(values.grain || 0) / 100);
      set("uGrainSize", values.grainSize);
      set("uGrainColor", Number(values.grainColor || 0) / 100);
      set("uVignette", Number(values.vignette || 0) / 100);
      set("uFilmFormatScale", options.filmFormatScale || 1);
      set("uSeed", String(values.selectedFilm || "acros-100").length * 17 + 11);
      ["SrgbToXyz", "D65ToD50", "XyzToProphoto", "ProphotoToXyz", "D50ToD65", "XyzToSrgb"].forEach((name) => gl.uniformMatrix3fv(locations[`u${name}`], false, matrixData(config.matrices[name[0].toLowerCase() + name.slice(1)])));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      return true;
    }

    return {
      renderer: gl.getParameter(gl.RENDERER),
      render,
      destroy() {
        canvas.removeEventListener("webglcontextlost", contextLost);
        gl.deleteTexture(sourceTexture);
        gl.deleteTexture(lutTextures.adapter);
        gl.deleteTexture(lutTextures.film);
        gl.deleteBuffer(positionBuffer);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
      },
    };
  }

  window.FilmGpuPreview = { create };
})();
