/* ============================================================================
 * 100% 브라우저 내장 Supertone Supertonic-2 ONNX 한국어 여성 AI 음성 엔진
 * - 별도 유료 백엔드 서버 없이 Vercel 정적 호스팅에서도 바로 작동!
 * - 라이선스: MIT (코드) / OpenRAIL-M (가중치) · 저작권 무료
 * - 최초 1회 모델(250MB) 자동 다운로드 후 브라우저 Cache API에 영구 저장
 * - WebGPU 가속 우선 사용, 미지원 기기는 WebAssembly(WASM) 자동 폴백
 * ============================================================================ */
window.CBT_SUPERTONIC_WEB = (() => {
  'use strict';

  const HF_BASE = 'https://huggingface.co/Supertone/supertonic-2/resolve/main';
  const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
  const ORT_SCRIPT_SRI = 'sha384-l/kzpOl2DEfJXExKcb3MxVpF46L+SrAoPHyOUj5yfJ1/b0UjsuMEsnlwf6mtVbCh';
  const CACHE_NAME = 'civil-cbt-supertonic2-v1';

  const MODEL_FILES = [
    { key: 'cfg', path: 'onnx/tts.json', type: 'json', weight: 0.01 },
    { key: 'indexer', path: 'onnx/unicode_indexer.json', type: 'json', weight: 0.25 },
    { key: 'dp', path: 'onnx/duration_predictor.onnx', type: 'buf', weight: 1.45 },
    { key: 'textEnc', path: 'onnx/text_encoder.onnx', type: 'buf', weight: 26.16 },
    { key: 'vecEst', path: 'onnx/vector_estimator.onnx', type: 'buf', weight: 126.33 },
    { key: 'vocoder', path: 'onnx/vocoder.onnx', type: 'buf', weight: 96.71 }
  ];

  let ortLoaded = false;
  let ready = false;
  let loadPromise = null;
  let activeProvider = 'wasm';
  let hasRealWebGPU = null;
  let cfg = null;
  let indexer = null;
  let dpOrt = null;
  let textEncOrt = null;
  let vecEstOrt = null;
  let vocoderOrt = null;
  const styleCache = new Map(); // voiceId -> { ttl: Tensor, dp: Tensor }
  const progressListeners = new Set();
  let lastProgress = { pct: 0, msg: '' };
  let synthQueue = Promise.resolve();

  function loadOrtScript() {
    if (window.ort) { ortLoaded = true; return Promise.resolve(window.ort); }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ORT_CDN + 'ort.all.min.js';
      s.integrity = ORT_SCRIPT_SRI;
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        if (!window.ort) return reject(new Error('onnxruntime-web 로드 실패'));
        window.ort.env.wasm.wasmPaths = ORT_CDN;
        window.ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        ortLoaded = true;
        resolve(window.ort);
      };
      s.onerror = () => reject(new Error('ONNX Runtime Web CDN 로드 실패'));
      document.head.appendChild(s);
    });
  }

  async function fetchCached(relPath, asJson, onBytes) {
    const url = `${HF_BASE}/${relPath}`;
    let cache = null;
    try {
      if ('caches' in window) cache = await caches.open(CACHE_NAME);
    } catch {}

    if (cache) {
      const hit = await cache.match(url);
      if (hit && hit.ok) {
        if (asJson) return hit.json();
        const buf = await hit.arrayBuffer();
        if (onBytes) onBytes(buf.byteLength, buf.byteLength);
        return new Uint8Array(buf);
      }
    }

    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`모델 다운로드 실패 (${relPath}: HTTP ${res.status})`);

    if (asJson) {
      const clone = res.clone();
      const data = await res.json();
      if (cache) { try { await cache.put(url, clone); } catch {} }
      return data;
    }

    const total = Number(res.headers.get('content-length') || 0);
    if (!res.body || !res.body.getReader) {
      const ab = await res.arrayBuffer();
      if (onBytes) onBytes(ab.byteLength, total || ab.byteLength);
      if (cache) { try { await cache.put(url, new Response(ab.slice(0))); } catch {} }
      return new Uint8Array(ab);
    }

    const reader = res.body.getReader();
    const parts = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.byteLength;
      if (onBytes) onBytes(received, total);
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.byteLength;
    }
    if (cache) {
      try {
        await cache.put(url, new Response(merged.buffer.slice(0), {
          headers: { 'Content-Type': 'application/octet-stream' }
        }));
      } catch {}
    }
    return merged;
  }

  async function detectWebGPU() {
    if (hasRealWebGPU !== null) return hasRealWebGPU;
    try {
      if (typeof navigator !== 'undefined' && navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
        const adapter = await navigator.gpu.requestAdapter();
        hasRealWebGPU = Boolean(adapter);
        return hasRealWebGPU;
      }
    } catch {}
    hasRealWebGPU = false;
    return false;
  }

  async function createSessionSmart(ort, bytes) {
    const canGpu = await detectWebGPU();
    if (canGpu) {
      try {
        const s = await ort.InferenceSession.create(bytes, {
          executionProviders: ['webgpu', 'wasm'],
          graphOptimizationLevel: 'all'
        });
        activeProvider = 'webgpu';
        return s;
      } catch {}
    }
    activeProvider = 'wasm';
    return ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
  }

  function broadcastProgress(pct, msg) {
    lastProgress = { pct, msg };
    progressListeners.forEach((fn) => { try { fn(pct, msg); } catch {} });
  }

  async function ensureLoaded(onProgress) {
    if (ready) return true;
    if (typeof onProgress === 'function') {
      progressListeners.add(onProgress);
      if (lastProgress.msg) {
        try { onProgress(lastProgress.pct, lastProgress.msg); } catch {}
      }
    }
    if (loadPromise) {
      return loadPromise.finally(() => {
        if (typeof onProgress === 'function') progressListeners.delete(onProgress);
      });
    }

    loadPromise = (async () => {
      broadcastProgress(2, 'ONNX AI 엔진 준비 중...');
      const ort = await loadOrtScript();

      const totalWeight = MODEL_FILES.reduce((a, f) => a + f.weight, 0);
      let doneWeight = 0;
      const loaded = {};

      for (const f of MODEL_FILES) {
        const pctStart = Math.round((doneWeight / totalWeight) * 84) + 4;
        broadcastProgress(pctStart, `다정한 여성 AI 음성 로딩 중 (${pctStart}%)`);
        loaded[f.key] = await fetchCached(f.path, f.type === 'json', (rec, tot) => {
          if (tot > 0) {
            const frac = Math.min(1, rec / tot);
            const pct = Math.min(88, Math.round(((doneWeight + f.weight * frac) / totalWeight) * 84) + 4);
            broadcastProgress(pct, `다정한 여성 AI 음성 다운로드 중 (${pct}%) · 최초 1회만 저장`);
          }
        });
        doneWeight += f.weight;
      }

      cfg = loaded.cfg;
      indexer = loaded.indexer;

      broadcastProgress(90, 'AI 목소리 엔진 초기화 중...');
      dpOrt = await createSessionSmart(ort, loaded.dp);
      broadcastProgress(93, '텍스트 인코더 초기화 중...');
      textEncOrt = await createSessionSmart(ort, loaded.textEnc);
      broadcastProgress(96, '음성 합성기 초기화 중...');
      vecEstOrt = await createSessionSmart(ort, loaded.vecEst);
      broadcastProgress(98, '고음질 보코더 초기화 중...');
      vocoderOrt = await createSessionSmart(ort, loaded.vocoder);

      ready = true;
      broadcastProgress(100, '다정한 여성 AI 음성 준비 완료!');
      return true;
    })().catch((err) => {
      loadPromise = null;
      throw err;
    });

    return loadPromise.finally(() => {
      if (typeof onProgress === 'function') progressListeners.delete(onProgress);
    });
  }

  function flattenFloat32(nested) {
    const flat = [];
    const walk = (x) => {
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) walk(x[i]);
      } else {
        flat.push(Number(x));
      }
    };
    walk(nested);
    return new Float32Array(flat);
  }

  async function getStyle(voiceId = 'F5') {
    const vid = ['F1', 'F2', 'F3', 'F4', 'F5'].includes(voiceId) ? voiceId : 'F5';
    if (styleCache.has(vid)) return styleCache.get(vid);
    const json = await fetchCached(`voice_styles/${vid}.json`, true);
    const ort = window.ort;
    const ttl = new ort.Tensor('float32', flattenFloat32(json.style_ttl.data), json.style_ttl.dims);
    const dp = new ort.Tensor('float32', flattenFloat32(json.style_dp.data), json.style_dp.dims);
    const style = { ttl, dp };
    styleCache.set(vid, style);
    return style;
  }

  /* ---------------- Exact Supertonic-2 Text Preprocessing (matches core.py) ---------------- */
  function preprocessText(rawText, lang = 'ko') {
    let text = String(rawText || '');
    try { text = text.normalize('NFKD'); } catch {}
    text = text
      .replace(/[\u2013\u2011\u2014]/g, '-')
      .replace(/[\u00af_\[\]|\/#→←]/g, ' ')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019\u00b4`]/g, "'")
      .replace(/[♥☆♡©\\]/g, '')
      .replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[.!?;:,'")\]]$/.test(text)) text += '.';
    return `<${lang}>${text}</${lang}>`;
  }

  function encodeText(rawText, lang = 'ko') {
    const processed = preprocessText(rawText, lang);
    const spaceId = indexer[32] >= 0 ? indexer[32] : 0;
    const ids = [];
    for (let i = 0; i < processed.length; i++) {
      const code = processed.charCodeAt(i);
      const mapped = code < indexer.length ? indexer[code] : -1;
      ids.push(mapped >= 0 ? mapped : spaceId);
    }
    const len = ids.length;
    const textIds = new BigInt64Array(len);
    const textMask = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      textIds[i] = BigInt(ids[i]);
      textMask[i] = 1.0;
    }
    const ort = window.ort;
    return {
      textIdsTensor: new ort.Tensor('int64', textIds, [1, len]),
      textMaskTensor: new ort.Tensor('float32', textMask, [1, 1, len])
    };
  }

  function gaussianRand() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function postProcessAudio(rawFloat32, sampleRate) {
    let arr = rawFloat32;
    if (!arr || arr.length === 0) return new Float32Array(0);

    // Trim excessive leading/trailing silence (keep 35ms natural breath)
    let first = 0;
    let last = arr.length - 1;
    while (first < arr.length && Math.abs(arr[first]) < 0.008) first++;
    while (last > first && Math.abs(arr[last]) < 0.008) last--;
    const pad = Math.floor(sampleRate * 0.035);
    const s = Math.max(0, first - pad);
    const e = Math.min(arr.length, last + pad + 1);
    const out = new Float32Array(arr.subarray(s, e));

    // Smooth 12ms fade-in/out to prevent clicks between gapless chunks
    const fade = Math.min(Math.floor(sampleRate * 0.012), Math.floor(out.length / 4));
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      out[i] *= g;
      out[out.length - 1 - i] *= g;
    }

    // Gentle peak normalization (-1.5 dBFS)
    let peak = 0;
    for (let i = 0; i < out.length; i++) {
      const a = Math.abs(out[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1e-4) {
      const scale = 0.84 / peak;
      for (let i = 0; i < out.length; i++) out[i] *= scale;
    }
    return out;
  }

  async function synthesizeInternal(text, voiceId = 'F5', speed = 1.05, totalSteps = 5, onProgress) {
    await ensureLoaded(onProgress);
    const ort = window.ort;
    const style = await getStyle(voiceId);
    const { textIdsTensor, textMaskTensor } = encodeText(text, 'ko');

    const dpOut = await dpOrt.run({
      text_ids: textIdsTensor,
      style_dp: style.dp,
      text_mask: textMaskTensor
    });
    const durTensor = dpOut[dpOrt.outputNames[0]];
    const rawDur = Math.max(0.25, Number(durTensor.data[0]) / Math.min(1.5, Math.max(0.8, speed)));

    const encOut = await textEncOrt.run({
      text_ids: textIdsTensor,
      style_ttl: style.ttl,
      text_mask: textMaskTensor
    });
    const textEmbTensor = encOut[textEncOrt.outputNames[0]];

    const sampleRate = cfg.ae.sample_rate || 44100;
    const baseChunk = cfg.ae.base_chunk_size || 512;
    const compress = cfg.ttl.chunk_compress_factor || 6;
    const ldim = cfg.ttl.latent_dim || 24;
    const chunkSize = baseChunk * compress;
    const wavLen = Math.max(chunkSize, Math.floor(rawDur * sampleRate));
    const latentLen = Math.ceil(wavLen / chunkSize);
    const latentDim = ldim * compress;

    const latentMaskData = new Float32Array(latentLen);
    latentMaskData.fill(1.0);
    const latentMaskTensor = new ort.Tensor('float32', latentMaskData, [1, 1, latentLen]);

    const xtData = new Float32Array(latentDim * latentLen);
    for (let i = 0; i < xtData.length; i++) xtData[i] = gaussianRand();
    let xtTensor = new ort.Tensor('float32', xtData, [1, latentDim, latentLen]);

    const totalStepTensor = new ort.Tensor('float32', new Float32Array([totalSteps]), [1]);
    for (let step = 0; step < totalSteps; step++) {
      const curStepTensor = new ort.Tensor('float32', new Float32Array([step]), [1]);
      const vecOut = await vecEstOrt.run({
        noisy_latent: xtTensor,
        text_emb: textEmbTensor,
        style_ttl: style.ttl,
        text_mask: textMaskTensor,
        latent_mask: latentMaskTensor,
        current_step: curStepTensor,
        total_step: totalStepTensor
      });
      xtTensor = vecOut[vecEstOrt.outputNames[0]];
    }

    const vocOut = await vocoderOrt.run({ latent: xtTensor });
    const wavRaw = vocOut[vocoderOrt.outputNames[0]].data;
    const samples = postProcessAudio(wavRaw, sampleRate);
    return { samples, sampleRate };
  }

  function synthesize(text, voiceId = 'F5', speed = 1.05, totalSteps = 5, onProgress) {
    const job = synthQueue.then(() => synthesizeInternal(text, voiceId, speed, totalSteps, onProgress));
    synthQueue = job.catch(() => {});
    return job;
  }

  return {
    ensureLoaded,
    synthesize,
    isReady: () => ready,
    getProvider: () => activeProvider
  };
})();
