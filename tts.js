/* ============================================================================
 * 다정하고 자연스럽게 연결되는 한국어 여성 AI 음성 엔진 (tts.js)
 * - 1순위(로컬 서버): Supertone Supertonic ONNX 로컬 WAV 파이프라인
 * - 2순위(Vercel 웹 호스팅): 100% 브라우저 내장 Supertone Supertonic-2 ONNX (WebGPU/WASM)
 *   · 기본 목소리 F5 (다정하고 부드러운 여성 선생님), F2/F1/F4/F3 선택 가능
 *   · 라이선스: MIT (코드) / OpenRAIL-M (가중치) · 저작권 무료
 *   · Web Audio API 무끊김(Gapless) 스케줄링으로 자연스럽게 이어지는 연속 발화
 * - 3순위(즉시/폴백): 브라우저 기본 Web Speech API (음성설정에서 즉시 전환 가능)
 * ============================================================================ */
window.CBT_TTS = (() => {
  'use strict';

  const STORAGE = {
    rate: 'civil_cbt_easy_tts_rate_v2',
    voice: 'civil_cbt_easy_tts_voice_v2',
    autoRead: 'civil_cbt_easy_tts_autoread_v1'
  };

  const WEBSPEECH_VOICE_ID = '__webspeech__';

  const DEFAULT_SUPERTONIC_VOICES = [
    { id: 'F5', name: '다정한 선생님 (F5 · 부드럽고 따뜻한 여성)' },
    { id: 'F2', name: '친근한 선생님 (F2 · 밝고 명랑한 여성)' },
    { id: 'F1', name: '차분한 선생님 (F1 · 안정적이고 편안한 여성)' },
    { id: 'F4', name: '강의형 선생님 (F4 · 깔끔하고 또렷한 여성)' },
    { id: 'F3', name: '아나운서 (F3 · 명확한 방송형 여성)' }
  ];

  const webSpeechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  const hasBrowserSupertonic = () => typeof window !== 'undefined' && Boolean(window.CBT_SUPERTONIC_WEB);

  // Engine mode: 'local-supertonic' | 'browser-supertonic' | 'webspeech'
  let engineMode = hasBrowserSupertonic() ? 'browser-supertonic' : 'webspeech';
  let engineInfo = {
    available: hasBrowserSupertonic(),
    engine: 'Supertone Supertonic-2 (ONNX)',
    license: 'MIT / OpenRAIL-M (저작권 무료)',
    voices: DEFAULT_SUPERTONIC_VOICES
  };

  let selectedVoice = localStorage.getItem(STORAGE.voice) || 'F5';
  let rate = Number(localStorage.getItem(STORAGE.rate) || '1.05') || 1.05;
  let autoRead = localStorage.getItem(STORAGE.autoRead) === '1';

  let state = {
    status: 'idle', // 'idle' | 'loading' | 'playing' | 'paused'
    mode: '',       // 'explanation' | 'question' | 'glossary'
    activeSegId: null,
    currentIdx: 0,
    totalChunks: 0,
    loadingText: '',
    loadingPct: 0
  };

  let playToken = 0;
  let listeners = new Set();
  let voiceListeners = new Set();
  let webVoices = [];
  let isNotifyingVoices = false;

  // Web Audio API gapless playback state + client-side caches
  let audioCtx = null;
  let activeSources = [];
  let highlightTimers = [];
  let abortCtrl = null;
  const wavCache = new Map();       // cacheKey -> ArrayBuffer (local server)
  const pendingFetches = new Map(); // cacheKey -> Promise<ArrayBuffer>
  const pcmCache = new Map();       // cacheKey -> { samples: Float32Array, sampleRate: number } (browser ONNX)

  function isNeuralSelected() {
    return (engineMode === 'local-supertonic' || engineMode === 'browser-supertonic') && selectedVoice !== WEBSPEECH_VOICE_ID;
  }

  function emit() {
    const snap = {
      ...state,
      rate,
      autoRead,
      supported: engineMode !== 'webspeech' || webSpeechSupported,
      engineMode: isNeuralSelected() ? engineMode : 'webspeech',
      engineLicense: engineInfo.license,
      voiceId: selectedVoice
    };
    listeners.forEach((fn) => { try { fn(snap); } catch {} });
  }

  function notifyVoiceListeners() {
    if (isNotifyingVoices) return;
    isNotifyingVoices = true;
    try {
      const list = getVoices();
      voiceListeners.forEach((fn) => { try { fn(list); } catch {} });
    } finally {
      isNotifyingVoices = false;
    }
  }

  /* ---------------- Detect Local Server vs Browser ONNX Supertonic-2 ---------------- */
  async function probeSupertonic() {
    try {
      const res = await fetch('/api/tts/info', { cache: 'no-cache' });
      if (!res.ok) throw new Error('no backend');
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('json')) throw new Error('not json');
      const info = await res.json();
      if (info && Array.isArray(info.voices)) {
        engineMode = 'local-supertonic';
        engineInfo = info;
        if (selectedVoice !== WEBSPEECH_VOICE_ID && !info.voices.some((v) => v.id === selectedVoice)) {
          selectedVoice = info.defaultVoice || 'F5';
        }
        notifyVoiceListeners();
        emit();
        if (!info.available) {
          setTimeout(() => {
            fetch('/api/tts/info', { cache: 'no-cache' })
              .then((r) => r.ok ? r.json() : null)
              .then((i2) => { if (i2 && i2.available) { engineInfo = i2; emit(); } })
              .catch(() => {});
          }, 1500);
        }
        return;
      }
    } catch {}

    if (hasBrowserSupertonic()) {
      engineMode = 'browser-supertonic';
      engineInfo = {
        available: true,
        engine: 'Supertone Supertonic-2 (브라우저 ONNX)',
        license: 'MIT / OpenRAIL-M (저작권 무료)',
        voices: DEFAULT_SUPERTONIC_VOICES
      };
      if (selectedVoice !== WEBSPEECH_VOICE_ID && !DEFAULT_SUPERTONIC_VOICES.some((v) => v.id === selectedVoice)) {
        selectedVoice = 'F5';
      }
      notifyVoiceListeners();
      emit();
      return;
    }

    engineMode = 'webspeech';
    refreshWebVoices(true);
    emit();
  }
  probeSupertonic();

  /* ---------------- Web Speech Fallback Helpers (Non-Recursive!) ---------------- */
  function rankKoreanWebVoice(v) {
    const lang = (v.lang || '').toLowerCase();
    const name = (v.name || '').toLowerCase();
    if (!lang.startsWith('ko') && !name.includes('korean') && !name.includes('한국')) return -1;
    let score = 10;
    if (name.includes('sunhi') || name.includes('선희')) score += 60;
    if (name.includes('yuna') || name.includes('유나') || name.includes('sora')) score += 50;
    if (name.includes('google')) score += 40;
    if (name.includes('heami') || name.includes('혜미')) score += 25;
    if (name.includes('natural') || name.includes('online')) score += 20;
    if (lang === 'ko-kr') score += 5;
    return score;
  }

  function refreshWebVoices(notify = false) {
    if (!webSpeechSupported) return [];
    const raw = window.speechSynthesis.getVoices() || [];
    webVoices = raw
      .map((v) => ({ v, score: rankKoreanWebVoice(v) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.v);
    if (notify) notifyVoiceListeners();
    return webVoices;
  }

  if (webSpeechSupported) {
    refreshWebVoices(false);
    if ('onvoiceschanged' in window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => {
        refreshWebVoices(engineMode === 'webspeech');
      };
    }
  }

  function getVoices() {
    if (engineMode === 'local-supertonic' || engineMode === 'browser-supertonic') {
      const list = (engineInfo.voices || DEFAULT_SUPERTONIC_VOICES).map((v) => ({
        id: v.id,
        name: v.name,
        isNeural: true
      }));
      if (webSpeechSupported) {
        list.push({
          id: WEBSPEECH_VOICE_ID,
          name: '⚡ 브라우저 기본 음성 (즉시 재생 · 다운로드 없음)',
          isNeural: false
        });
      }
      return list;
    }
    if (!webVoices.length) refreshWebVoices(false);
    return webVoices.map((v) => ({ id: v.name, name: `${v.name} (${v.lang})`, isNeural: false, raw: v }));
  }

  /* ---------------- LaTeX & Engineering Text -> Warm Smooth Korean Speech ---------------- */

  function readBraced(str, startIdx) {
    if (startIdx >= str.length || str[startIdx] !== '{') return null;
    let depth = 0;
    let i = startIdx;
    while (i < str.length) {
      if (str[i] === '{') depth++;
      else if (str[i] === '}') {
        depth--;
        if (depth === 0) return { inner: str.slice(startIdx + 1, i), next: i + 1 };
      }
      i++;
    }
    return null;
  }

  function convertLatexFragment(latex) {
    let s = String(latex || '').trim();
    s = s.replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, ' $1 ');
    s = s.replace(/\\left|\\right|\\,|\\;|\\:|\\!|\\quad|\\qquad|\\displaystyle/g, ' ');

    function replaceFracs(expr) {
      let out = '';
      let i = 0;
      while (i < expr.length) {
        if (expr.startsWith('\\frac', i) || expr.startsWith('\\dfrac', i)) {
          const cmdLen = expr.startsWith('\\dfrac', i) ? 6 : 5;
          let j = i + cmdLen;
          while (j < expr.length && expr[j] === ' ') j++;
          const num = readBraced(expr, j);
          if (!num) { out += expr[i++]; continue; }
          j = num.next;
          while (j < expr.length && expr[j] === ' ') j++;
          const den = readBraced(expr, j);
          if (!den) { out += expr[i++]; continue; }
          const nClean = replaceFracs(num.inner).trim();
          const dClean = replaceFracs(den.inner).trim();
          if (/^\d+$/.test(nClean) && /^\d+$/.test(dClean)) {
            out += ` ${dClean}분의 ${nClean} `;
          } else {
            out += ` ${nClean} 나누기 ${dClean} `;
          }
          i = den.next;
        } else {
          out += expr[i++];
        }
      }
      return out;
    }
    s = replaceFracs(s);

    function replaceSqrt(expr) {
      let out = '';
      let i = 0;
      while (i < expr.length) {
        if (expr.startsWith('\\sqrt', i)) {
          let j = i + 5;
          while (j < expr.length && expr[j] === ' ') j++;
          const arg = readBraced(expr, j);
          if (!arg) { out += ' 루트 '; i += 5; continue; }
          out += ` 루트 ${replaceSqrt(arg.inner).trim()} `;
          i = arg.next;
        } else {
          out += expr[i++];
        }
      }
      return out;
    }
    s = replaceSqrt(s);

    s = s.replace(/(\d+(?:\.\d+)?)\s*(?:\\times|\\cdot|×)\s*10\^(?:\{\s*-(\d+)\s*\}|-(\d+))/g, (_, m, e1, e2) => `${m} 곱하기 10의 마이너스 ${e1 || e2}제곱`);
    s = s.replace(/(\d+(?:\.\d+)?)\s*(?:\\times|\\cdot|×)\s*10\^(?:\{\s*(\d+)\s*\}|(\d+))/g, (_, m, e1, e2) => `${m} 곱하기 10의 ${e1 || e2}제곱`);
    s = s.replace(/10\^(?:\{\s*-(\d+)\s*\}|-(\d+))/g, (_, e1, e2) => `10의 마이너스 ${e1 || e2}제곱`);
    s = s.replace(/10\^(?:\{\s*(\d+)\s*\}|(\d+))/g, (_, e1, e2) => `10의 ${e1 || e2}제곱`);

    s = s.replace(/\^\s*\{\s*\\circ\s*\}/g, '도');
    s = s.replace(/\^\s*\\circ/g, '도');
    s = s.replace(/\\circ/g, '도');

    s = s.replace(/\^(?:\{\s*2\s*\}|2(?![0-9]))/g, ' 제곱');
    s = s.replace(/\^(?:\{\s*3\s*\}|3(?![0-9]))/g, ' 세제곱');
    s = s.replace(/\^(?:\{\s*4\s*\}|4(?![0-9]))/g, ' 네제곱');
    s = s.replace(/\^(?:\{\s*-(\d+)\s*\}|-(\d+))/g, (_, e1, e2) => `의 마이너스 ${e1 || e2}제곱`);
    s = s.replace(/\^\{([^{}]+)\}/g, '의 $1제곱');
    s = s.replace(/\^(\d+)/g, '의 $1제곱');

    s = s.replace(/\\sin/g, ' 사인 ').replace(/\\cos/g, ' 코사인 ').replace(/\\tan/g, ' 탄젠트 ');
    s = s.replace(/\\ln/g, ' 자연로그 ').replace(/\\log/g, ' 로그 ');
    s = s.replace(/\\min/g, ' 최소 ').replace(/\\max/g, ' 최대 ');

    const GREEK = [
      [/\\epsilon_v/g, ' 체적변형률 '],
      [/\\epsilon/g, ' 엡실론 '],
      [/\\sigma/g, ' 시그마 '],
      [/\\Sigma/g, ' 시그마 '],
      [/\\sum/g, ' 총합 '],
      [/\\nu/g, ' 뉴 '],
      [/\\tau/g, ' 타우 '],
      [/\\gamma/g, ' 감마 '],
      [/\\Delta|\\delta/g, ' 델타 '],
      [/\\theta/g, ' 세타 '],
      [/\\phi|\\varphi|\\Phi/g, ' 파이 '],
      [/\\pi/g, ' 원주율 파이 '],
      [/\\rho/g, ' 로 '],
      [/\\eta/g, ' 효율 에타 '],
      [/\\lambda/g, ' 람다 '],
      [/\\mu/g, ' 뮤 '],
      [/\\alpha/g, ' 알파 '],
      [/\\beta/g, ' 베타 '],
      [/\\omega/g, ' 오메가 '],
      [/\\ell/g, ' 길이 엘 '],
      [/\\times|\\cdot/g, ' 곱하기 '],
      [/\\div/g, ' 나누기 '],
      [/\\pm/g, ' 플러스 마이너스 '],
      [/\\approx/g, ' 약 '],
      [/\\sim/g, ' 에서 '],
      [/\\le|\\leq/g, ' 이하 '],
      [/\\ge|\\geq/g, ' 이상 '],
      [/\\rightarrow|\\implies|\\to/g, ' 따라서 '],
      [/\\angle/g, ' 각도 ']
    ];
    for (const [rx, rep] of GREEK) s = s.replace(rx, rep);

    s = s.replace(/_\{([^{}]+)\}/g, ' $1 ').replace(/_([A-Za-z0-9]+)/g, ' $1 ');
    s = s.replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}]/g, ' ');
    s = s.replace(/\)\s*\(/g, ' 곱하기 ');
    s = s.replace(/=/g, ' 는 ').replace(/\+/g, ' 더하기 ');
    s = s.replace(/(\d|\)|[A-Za-z])\s*-\s*(\d|\(|[A-Za-z])/g, '$1 빼기 $2');
    s = s.replace(/(^|[\s(])-(\d+(?:\.\d+)?)/g, '$1마이너스 $2');
    s = s.replace(/\//g, ' 나누기 ').replace(/[()]/g, ' ');
    return s;
  }

  function mathToKoreanSpeech(raw) {
    if (!raw) return '';
    let s = String(raw);

    s = s.replace(/<\/tr>/gi, '. ').replace(/<\/(?:td|th)>/gi, ', ');
    s = s.replace(/<br\s*\/?>/gi, '. ');
    s = s.replace(/<sup>\s*-(\d+)\s*<\/sup>/gi, '의 마이너스 $1제곱');
    s = s.replace(/<sup>\s*2\s*<\/sup>/gi, ' 제곱');
    s = s.replace(/<sup>\s*3\s*<\/sup>/gi, ' 세제곱');
    s = s.replace(/<sup>\s*([^<]+)\s*<\/sup>/gi, '의 $1제곱');
    s = s.replace(/<sub>\s*([^<]+)\s*<\/sub>/gi, ' $1 ');
    s = s.replace(/<img[^>]*>/gi, ' 그림 ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '와 ').replace(/&lt;/g, ' 미만 ').replace(/&gt;/g, ' 초과 ');

    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner) => ' ' + convertLatexFragment(inner) + ' ');
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) => ' ' + convertLatexFragment(inner) + ' ');
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) => ' ' + convertLatexFragment(inner) + ' ');
    s = s.replace(/\$([^$]+?)\$/g, (_, inner) => ' ' + convertLatexFragment(inner) + ' ');

    const dirMap = { N: '북쪽', S: '남쪽', E: '동쪽', W: '서쪽' };
    s = s.replace(/\b([NS])\s*(\d+(?:\.\d+)?)\s*°?\s*([EW])\b/g, (_, d1, deg, d2) => `${dirMap[d1]}에서 ${dirMap[d2]}으로 ${deg}도`);

    s = s.replace(/(\d+(?:\.\d+)?)\s*×\s*10\^-(\d+)/g, '$1 곱하기 10의 마이너스 $2제곱');
    s = s.replace(/(\d+(?:\.\d+)?)\s*×\s*10\^(\d+)/g, '$1 곱하기 10의 $2제곱');
    s = s.replace(/(\d+(?:\.\d+)?)\s*×\s*10⁻(\d+)/g, '$1 곱하기 10의 마이너스 $2제곱');
    s = s.replace(/²/g, ' 제곱').replace(/³/g, ' 세제곱').replace(/⁴/g, ' 네제곱');
    s = s.replace(/⁻¹/g, '의 마이너스 1제곱').replace(/⁻²/g, '의 마이너스 2제곱').replace(/⁻³/g, '의 마이너스 3제곱').replace(/⁻⁴/g, '의 마이너스 4제곱');

    const UNITS = [
      [/m\s*세제곱\s*\/\s*m\s*제곱\s*[·∙.]\s*d/gi, ' 제곱미터 하루당 세제곱미터 '],
      [/m3\/m2[·∙.]d/gi, ' 제곱미터 하루당 세제곱미터 '],
      [/m\s*세제곱\s*\/\s*(?:sec|s)\b/gi, ' 초당 세제곱미터 '],
      [/m3\/(?:sec|s)\b/gi, ' 초당 세제곱미터 '],
      [/m\s*세제곱\s*\/\s*(?:day|d|일)\b/gi, ' 하루당 세제곱미터 '],
      [/m3\/(?:day|d|일)\b/gi, ' 하루당 세제곱미터 '],
      [/kgf?\/cm\s*제곱|kgf?\/cm2/gi, ' 제곱센티미터당 킬로그램 '],
      [/kN\/m\s*제곱/gi, ' 제곱미터당 킬로뉴턴 '],
      [/kN\/m\s*세제곱/gi, ' 세제곱미터당 킬로뉴턴 '],
      [/t\/m\s*제곱/gi, ' 제곱미터당 톤 '],
      [/t\/m\s*세제곱/gi, ' 세제곱미터당 톤 '],
      [/N\/mm\s*제곱/gi, ' 제곱밀리미터당 뉴턴 '],
      [/kN[·∙.]m\b/gi, ' 킬로뉴턴 미터 '],
      [/t[·∙.]m\b/gi, ' 톤 미터 '],
      [/mm\/h(?:r)?\b/gi, ' 시간당 밀리미터 '],
      [/m\/(?:sec|s)\b/gi, ' 초당 미터 '],
      [/cm\/(?:sec|s)\b/gi, ' 초당 센티미터 '],
      [/mg\/L\b/gi, ' 리터당 밀리그램 '],
      [/ℓ\s*\/\s*sec/gi, ' 초당 리터 '],
      [/\bMPa\b/g, ' 메가파스칼 '],
      [/\bkPa\b/g, ' 킬로파스칼 '],
      [/\bkN\b/g, ' 킬로뉴턴 '],
      [/\bkW\b/g, ' 킬로와트 '],
      [/\bkgf\b/g, ' 킬로그램힘 '],
      [/\bkg\b/g, ' 킬로그램 '],
      [/\bmm\s*네제곱/gi, ' 밀리미터 네제곱 '],
      [/\bmm\s*제곱/gi, ' 제곱밀리미터 '],
      [/\bcm\s*제곱/gi, ' 제곱센티미터 '],
      [/\bkm\s*제곱/gi, ' 제곱킬로미터 '],
      [/\bm\s*제곱/gi, ' 제곱미터 '],
      [/\bm\s*세제곱/gi, ' 세제곱미터 '],
      [/(\d)\s*km\b/g, '$1 킬로미터'],
      [/(\d)\s*cm\b/g, '$1 센티미터'],
      [/(\d)\s*mm\b/g, '$1 밀리미터'],
      [/(\d)\s*m\b/g, '$1 미터'],
      [/(\d)\s*ha\b/g, '$1 헥타르'],
      [/(\d)\s*%/g, '$1 퍼센트']
    ];
    for (const [rx, rep] of UNITS) s = s.replace(rx, rep);

    // Clear Sino-Korean choice numbers so TTS says "사번" instead of "네 번"!
    s = s.replace(/①\s*번?/g, '일번 ').replace(/②\s*번?/g, '이번 ').replace(/③\s*번?/g, '삼번 ').replace(/④\s*번?/g, '사번 ');
    s = s.replace(/(^|[^0-9])1번/g, '$1일번').replace(/(^|[^0-9])2번/g, '$1이번').replace(/(^|[^0-9])3번/g, '$1삼번').replace(/(^|[^0-9])4번/g, '$1사번');

    // Make trailing .0 decimals crystal clear ("4.0" -> "4점 영")
    s = s.replace(/(\d+)\.0(?![0-9])/g, '$1점 영');

    s = s.replace(/√\(([^)]+)\)/g, '루트 $1').replace(/√/g, '루트 ');
    s = s.replace(/×/g, ' 곱하기 ').replace(/÷/g, ' 나누기 ');
    s = s.replace(/≈/g, ' 약 ').replace(/≥/g, ' 이상 ').replace(/≤/g, ' 이하 ');
    s = s.replace(/±/g, ' 플러스 마이너스 ').replace(/→/g, ' 그래서 ');
    s = s.replace(/°/g, '도');
    s = s.replace(/π/g, ' 원주율 파이 ').replace(/ν/g, ' 뉴 ').replace(/σ/g, ' 시그마 ')
         .replace(/ε/g, ' 엡실론 ').replace(/τ/g, ' 타우 ').replace(/γ/g, ' 감마 ')
         .replace(/δ|Δ/g, ' 델타 ').replace(/θ/g, ' 세타 ').replace(/φ/g, ' 파이 ')
         .replace(/η/g, ' 에타 ').replace(/λ/g, ' 람다 ').replace(/ρ/g, ' 로 ').replace(/Σ/g, ' 총합 ');
    s = s.replace(/=/g, ' 는 ').replace(/\+/g, ' 더하기 ');
    s = s.replace(/(\d|\))\s*-\s*(\d|\()/g, '$1 빼기 $2');
    s = s.replace(/(^|[\s(,])-(\d+(?:\.\d+)?)/g, '$1마이너스 $2');

    // Clean punctuation & emojis so intonation flows smoothly without choppy breaks!
    s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ');
    s = s.replace(/[⭕❌⭐✓✗▪•◆▶⏸⏹🔊🔈📖🌱💡🧩✏️🧠📌🔍⚠️🎯✨]/g, ' ');
    s = s.replace(/\[([^\]]+)\]/g, ' $1 ');
    s = s.replace(/:\s*/g, ', ');
    s = s.replace(/[()]/g, ' ');
    s = s.replace(/[,，]\s*[,，]+/g, ', ');
    s = s.replace(/\.\s*\.+/g, '. ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  /* ---------------- Group Segments into Smooth Flowing Audio Blocks ---------------- */
  // Block 0: short opening (~80-130 chars) for fast start!
  // Block 1+: smooth continuous paragraphs (~260 chars) so speech NEVER sounds choppy!
  function buildSmoothBlocks(segments) {
    const cleaned = [];
    for (const seg of segments) {
      const txt = mathToKoreanSpeech(seg.text);
      if (txt) cleaned.push({ segId: seg.id, text: txt });
    }
    if (!cleaned.length) return [];

    const blocks = [];
    // First block: keep opening concise so first audio plays super fast!
    const first = cleaned[0];
    if (first.text.length > 135) {
      const splitIdx = first.text.search(/[.!?]\s+/);
      if (splitIdx > 25 && splitIdx < 130) {
        blocks.push({ segId: first.segId, text: first.text.slice(0, splitIdx + 1).trim() });
        const rem = first.text.slice(splitIdx + 1).trim();
        if (rem) cleaned[0] = { segId: first.segId, text: rem };
        else cleaned.shift();
      } else {
        blocks.push(cleaned.shift());
      }
    } else {
      blocks.push(cleaned.shift());
    }

    // Merge remaining segments into wide, natural flowing paragraphs (up to ~300 chars)
    let cur = null;
    for (const item of cleaned) {
      if (!cur) {
        cur = { segId: item.segId, text: item.text };
      } else if (cur.text.length + item.text.length <= 300) {
        cur.text = `${cur.text} ${item.text}`;
      } else {
        blocks.push(cur);
        cur = { segId: item.segId, text: item.text };
      }
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  /* ---------------- Supertonic Neural WAV Fetch + Client Cache ---------------- */
  function fetchWavBuffer(text, voice, spd, signal) {
    const cacheKey = `${voice}|${spd.toFixed(2)}|${text}`;
    if (wavCache.has(cacheKey)) {
      return Promise.resolve(wavCache.get(cacheKey).slice(0));
    }
    if (pendingFetches.has(cacheKey)) {
      return pendingFetches.get(cacheKey).then((ab) => ab.slice(0));
    }
    const p = fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed: spd }),
      signal
    })
      .then((res) => {
        if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((ab) => {
        wavCache.set(cacheKey, ab.slice(0));
        if (wavCache.size > 120) {
          const oldest = wavCache.keys().next().value;
          wavCache.delete(oldest);
        }
        return ab;
      })
      .finally(() => pendingFetches.delete(cacheKey));

    pendingFetches.set(cacheKey, p);
    return p.then((ab) => ab.slice(0));
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function clearAudioPlayback() {
    if (abortCtrl) {
      try { abortCtrl.abort(); } catch {}
      abortCtrl = null;
    }
    for (const t of highlightTimers) clearTimeout(t);
    highlightTimers = [];
    for (const src of activeSources) {
      try { src.onended = null; src.stop(); src.disconnect(); } catch {}
    }
    activeSources = [];
    if (audioCtx && audioCtx.state === 'suspended') {
      try { audioCtx.resume(); } catch {}
    }
  }

  function stop() {
    const wasActive = state.status !== 'idle' || activeSources.length > 0;
    playToken += 1;
    clearAudioPlayback();
    if (webSpeechSupported && (!isNeuralSelected() || window.speechSynthesis.speaking)) {
      try { window.speechSynthesis.cancel(); } catch {}
    }
    state = { status: 'idle', mode: '', activeSegId: null, currentIdx: 0, totalChunks: 0, loadingText: '', loadingPct: 0 };
    if (wasActive) emit();
  }

  /* Speculative background prefetch of Block 0 when user reveals an explanation -> 0ms start!
   * Note: In browser-supertonic mode, only prefetch if model is ALREADY loaded so we never
   * silently download 250MB before the user explicitly clicks "음성으로 듣기". */
  function prefetch(segments) {
    if (!isNeuralSelected()) return;
    const blocks = buildSmoothBlocks(segments);
    if (!blocks.length) return;
    if (engineMode === 'local-supertonic' && engineInfo.available) {
      fetchWavBuffer(blocks[0].text, selectedVoice, rate).catch(() => {});
    } else if (engineMode === 'browser-supertonic' && hasBrowserSupertonic() && window.CBT_SUPERTONIC_WEB.isReady()) {
      const key = `${selectedVoice}|${rate.toFixed(2)}|${blocks[0].text}`;
      if (!pcmCache.has(key)) {
        window.CBT_SUPERTONIC_WEB.synthesize(blocks[0].text, selectedVoice, rate, 5)
          .then((res) => {
            pcmCache.set(key, res);
            if (pcmCache.size > 80) pcmCache.delete(pcmCache.keys().next().value);
          })
          .catch(() => {});
      }
    }
  }

  function schedulePcmBuffer(ctx, audioBuf, segId, idx, isLast, token, nextScheduleTime) {
    const now = ctx.currentTime;
    // Sample-accurate gapless scheduling (tiny 75ms natural breath between paragraphs)
    const startAt = Math.max(now + 0.02, nextScheduleTime);
    const updatedNext = startAt + audioBuf.duration + 0.075;

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    activeSources.push(src);

    const delayMs = Math.max(0, (startAt - ctx.currentTime) * 1000);
    const timer = setTimeout(() => {
      if (token !== playToken) return;
      state.status = 'playing';
      state.currentIdx = idx;
      state.activeSegId = segId;
      state.loadingText = '';
      emit();
    }, delayMs);
    highlightTimers.push(timer);

    if (isLast) {
      src.onended = () => {
        if (token !== playToken) return;
        stop();
      };
    }
    src.start(startAt);
    return updatedNext;
  }

  /* Seamless Gapless Local-Server Supertonic Web Audio Pipeline */
  async function playLocalSupertonicPipeline(blocks, mode, token) {
    const ctx = ensureAudioContext();
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    state = {
      status: 'loading',
      mode,
      activeSegId: blocks[0].segId,
      currentIdx: 0,
      totalChunks: blocks.length,
      loadingText: '다정한 여성 AI 음성 생성 중...',
      loadingPct: 0
    };
    emit();

    const fetchPromises = blocks.map((b, i) => {
      if (i <= 1) return fetchWavBuffer(b.text, selectedVoice, rate, signal);
      return null;
    });

    let nextScheduleTime = 0;

    try {
      for (let i = 0; i < blocks.length; i++) {
        if (token !== playToken) return;
        if (i + 1 < blocks.length && !fetchPromises[i + 1]) {
          fetchPromises[i + 1] = fetchWavBuffer(blocks[i + 1].text, selectedVoice, rate, signal);
        }
        const rawBuf = await fetchPromises[i];
        if (token !== playToken) return;

        const audioBuf = await ctx.decodeAudioData(rawBuf);
        if (token !== playToken) return;

        nextScheduleTime = schedulePcmBuffer(ctx, audioBuf, blocks[i].segId, i, i === blocks.length - 1, token, nextScheduleTime);
      }
    } catch (err) {
      if (token !== playToken) return;
      if (err && err.name === 'AbortError') return;
      if (hasBrowserSupertonic()) {
        engineMode = 'browser-supertonic';
        playBrowserSupertonicPipeline(blocks, mode, token);
      } else {
        engineMode = 'webspeech';
        playWebSpeechSmooth(blocks, mode, token);
      }
    }
  }

  /* 100% Client-Side Browser ONNX Supertone Supertonic-2 Pipeline (Zero Backend Needed on Vercel!) */
  async function playBrowserSupertonicPipeline(blocks, mode, token) {
    const ctx = ensureAudioContext();
    const webEngine = window.CBT_SUPERTONIC_WEB;

    state = {
      status: 'loading',
      mode,
      activeSegId: blocks[0].segId,
      currentIdx: 0,
      totalChunks: blocks.length,
      loadingText: webEngine.isReady() ? '다정한 여성 AI 음성 생성 중...' : '다정한 여성 AI 음성 준비 중 (최초 1회 캐시 저장)...',
      loadingPct: webEngine.isReady() ? 100 : 2
    };
    emit();

    const onProgress = (pct, msg) => {
      if (token !== playToken) return;
      if (state.status === 'loading') {
        state.loadingPct = pct;
        state.loadingText = msg;
        emit();
      }
    };

    let nextScheduleTime = 0;

    try {
      for (let i = 0; i < blocks.length; i++) {
        if (token !== playToken) return;
        const b = blocks[i];
        const key = `${selectedVoice}|${rate.toFixed(2)}|${b.text}`;
        let pcm = pcmCache.get(key);
        if (!pcm) {
          pcm = await webEngine.synthesize(b.text, selectedVoice, rate, 5, onProgress);
          if (token !== playToken) return;
          pcmCache.set(key, pcm);
          if (pcmCache.size > 80) pcmCache.delete(pcmCache.keys().next().value);
        }

        if (!pcm || !pcm.samples || pcm.samples.length === 0) continue;
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
        const audioBuf = ctx.createBuffer(1, pcm.samples.length, pcm.sampleRate);
        audioBuf.copyToChannel(pcm.samples, 0);

        nextScheduleTime = schedulePcmBuffer(ctx, audioBuf, b.segId, i, i === blocks.length - 1, token, nextScheduleTime);
      }
    } catch (err) {
      if (token !== playToken) return;
      console.warn('[CBT_TTS] Browser Supertonic fallback to WebSpeech:', err);
      playWebSpeechSmooth(blocks, mode, token);
    }
  }

  /* Smooth Web Speech API Fallback (single flowing utterance, ZERO 10s pause stutter!) */
  function playWebSpeechSmooth(blocks, mode, token) {
    if (!webSpeechSupported) {
      alert('이 브라우저는 음성 읽기를 지원하지 않습니다.');
      stop();
      return;
    }
    const fullText = blocks.map((b) => b.text).join(' ');
    state = { status: 'playing', mode, activeSegId: blocks[0]?.segId || null, currentIdx: 0, totalChunks: 1, loadingText: '', loadingPct: 0 };
    emit();

    const utt = new SpeechSynthesisUtterance(fullText);
    if (!webVoices.length) refreshWebVoices(false);
    const chosen = webVoices.find((v) => v.name === selectedVoice) || webVoices[0];
    if (chosen) utt.voice = chosen;
    utt.lang = chosen?.lang || 'ko-KR';
    utt.rate = rate;
    utt.pitch = 1.04;
    utt.onend = () => { if (token === playToken) stop(); };
    utt.onerror = () => { if (token === playToken) stop(); };
    try { window.speechSynthesis.speak(utt); } catch { stop(); }
  }

  function speakSegments(segments, mode = 'explanation') {
    stop();
    const blocks = buildSmoothBlocks(segments);
    if (!blocks.length) return false;
    const token = ++playToken;

    if (isNeuralSelected()) {
      // Unlock AudioContext synchronously during user click gesture (critical for Safari/Chrome!)
      ensureAudioContext();
      if (engineMode === 'local-supertonic') {
        playLocalSupertonicPipeline(blocks, mode, token);
      } else {
        playBrowserSupertonicPipeline(blocks, mode, token);
      }
    } else {
      playWebSpeechSmooth(blocks, mode, token);
    }
    return true;
  }

  function togglePause() {
    if (state.status === 'idle' || state.status === 'loading') return;
    if (isNeuralSelected() && audioCtx) {
      if (state.status === 'playing') {
        audioCtx.suspend().catch(() => {});
        state.status = 'paused';
        emit();
      } else if (state.status === 'paused') {
        audioCtx.resume().catch(() => {});
        state.status = 'playing';
        emit();
      }
      return;
    }
    if (webSpeechSupported) {
      if (state.status === 'playing') {
        try { window.speechSynthesis.pause(); } catch {}
        state.status = 'paused';
        emit();
      } else if (state.status === 'paused') {
        try { window.speechSynthesis.resume(); } catch {}
        state.status = 'playing';
        emit();
      }
    }
  }

  function setRate(newRate) {
    rate = Math.min(1.5, Math.max(0.8, Number(newRate) || 1.05));
    try { localStorage.setItem(STORAGE.rate, String(rate)); } catch {}
    emit();
  }

  function setVoiceByName(id) {
    selectedVoice = id || 'F5';
    try { localStorage.setItem(STORAGE.voice, selectedVoice); } catch {}
    emit();
  }

  function setAutoRead(enabled) {
    autoRead = Boolean(enabled);
    try { localStorage.setItem(STORAGE.autoRead, autoRead ? '1' : '0'); } catch {}
    emit();
  }

  return {
    supported: true,
    mathToKoreanSpeech,
    speakSegments,
    prefetch,
    togglePause,
    stop,
    setRate,
    setVoiceByName,
    setAutoRead,
    getRate: () => rate,
    getAutoRead: () => autoRead,
    getState: () => ({
      ...state,
      rate,
      autoRead,
      engineMode: isNeuralSelected() ? engineMode : 'webspeech',
      engineLicense: engineInfo.license,
      voiceId: selectedVoice
    }),
    getVoices,
    getActiveVoice: () => getVoices().find((v) => v.id === selectedVoice) || getVoices()[0] || null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    onVoicesReady(fn) { voiceListeners.add(fn); return () => voiceListeners.delete(fn); }
  };
})();
