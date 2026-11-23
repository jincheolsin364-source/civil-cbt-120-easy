/* ============================================================================
 * 초등학생 눈높이 토목기사 쉬운 풀이 엔진 (easy_explainer.js)
 * - 전 6,840문항에 대해 비유 + 용어·기호 사전 + 단계별 풀이 + 검증된 산수 과정 + 10초 꿀팁 생성
 * - 각 섹션과 1:1 매칭되는 자연스러운 한국어 음성 대본(speechSegments) 동시 생성
 * ============================================================================ */
window.CBT_EASY = (() => {
  'use strict';

  const CIRCLED = ['', '①', '②', '③', '④'];
  const buildCache = new Map();

  // Pre-sort terms and pre-compile symbol RegExps once for <1ms per-question build!
  const SORTED_TERMS = (window.CBT_CONCEPTS?.TERMS || []).slice().sort((a, b) => b.term.length - a.term.length);
  const COMPILED_SYMBOLS = (window.CBT_CONCEPTS?.SYMBOLS || []).map((sym) => {
    try { return { ...sym, re: new RegExp(sym.rx) }; } catch { return null; }
  }).filter(Boolean);

  const SUBJECT_FALLBACKS = {
    1: {
      emoji: '⚖️',
      title: '응용역학 기본 원리: 힘의 균형 맞추기',
      analogy: '다리나 건물이 무너지지 않고 서 있으려면 밀고 당기는 힘과 돌리려는 힘(모멘트)이 서로 딱 균형을 이뤄야 해요! 놀이터 시소처럼 왼쪽 힘과 오른쪽 힘이 똑같이 맞물리는 게 핵심이에요.',
      rule: '모든 역학 문제는 ① 그림 속 힘을 화살표로 표시하고 ② 평형 조건(가로=0, 세로=0, 모멘트=0) 또는 공식에 숫자를 차근차근 넣으면 풀려요!',
      tip: '외우기 꿀팁: 단위(m↔mm, kN↔N)가 섞여 있을 땐 계산 전에 꼭 하나로 통일하세요!'
    },
    2: {
      emoji: '🧭',
      title: '측량학 기본 원리: 땅의 길이·높이·방향 정확히 재기',
      analogy: '측량은 넓은 땅을 자와 각도기로 아주 정확하게 재서 종이 지도로 옮기는 작업이에요! 지구가 둥글거나 줄자가 늘어나서 생기는 작은 오차들을 똑똑하게 고쳐주는 게 포인트예요.',
      rule: '거리·높이·각도를 잴 때는 기준점(아는 값)에서 변화량을 더하거나 빼고, 여러 번 잰 값은 평균(최확값)을 구해요.',
      tip: '외우기 꿀팁: 길이는 그냥 비례, 넓이(면적)는 제곱에 비례한다는 걸 꼭 기억하세요!'
    },
    3: {
      emoji: '💧',
      title: '수리학·수문학 기본 원리: 물의 흐름과 에너지',
      analogy: '물은 높은 곳에서 낮은 곳으로 흐르고, 좁은 곳을 지날 땐 빨라져요! 호스에서 나오는 물이나 강물의 속도·압력·양(유량)을 에너지 보존 법칙으로 계산하는 과목이에요.',
      rule: '가장 중요한 기본 공식 2개는 연속방정식(Q = A×V)과 베르누이 에너지 법칙이에요!',
      tip: '외우기 꿀팁: 물의 단위중량은 9.8 kN/m³(또는 1 t/m³), 중력가속도 g = 9.8 m/s²!'
    },
    4: {
      emoji: '🏗️',
      title: '철근콘크리트·강구조 기본 원리: 튼튼하고 안전한 건물 짓기',
      analogy: '누르는 힘(압축)에 강한 콘크리트와 당기는 힘(인장)에 강한 철근이 손을 잡아 튼튼한 다리와 건물을 만들어요! 혹시 모를 사고를 막기 위해 늘 넉넉한 안전 기준을 지켜요.',
      rule: '건물이 부서지기 전에 철근이 먼저 늘어나 경고해 주는 안전한 설계(연성파괴)와 규정 치수를 확인하는 게 핵심이에요.',
      tip: '외우기 꿀팁: 콘크리트와 철근의 힘의 균형(C = T)과 안전 계수(φ)를 항상 떠올리세요!'
    },
    5: {
      emoji: '🪨',
      title: '토질 및 기초 기본 원리: 땅의 성질과 건물 받치기',
      analogy: '건물이 올라가는 땅은 흙알갱이·물·공기로 이루어져 있어요! 모래는 물이 잘 빠지고 마찰로 버티고, 진흙(점토)은 끈적하지만 물이 천천히 빠지며 가라앉는(압밀) 성질이 있어요.',
      rule: '흙의 종류(모래 vs 점토)를 먼저 구분하면 지지력·다짐·투수·토압 문제의 방향이 바로 보여요!',
      tip: '외우기 꿀팁: 모래 = 물 잘 빠짐·점착력 0 / 점토 = 물 안 빠짐·점착력 큼·압밀 침하 주의!'
    },
    6: {
      emoji: '🚰',
      title: '상하수도공학 기본 원리: 깨끗한 물 공급과 하수 정화',
      analogy: '강물을 깨끗하게 씻어 집으로 보내는 게 상수도, 집에서 쓴 더러운 물과 빗물을 모아 깨끗이 정화해 강으로 돌려보내는 게 하수도예요!',
      rule: '물 양(유량) × 농도 = 총 오염량(부하량) 관계와, 각 시설(취수·침전·여과·소독·활성슬러지)의 역할을 연결해서 이해하면 쉬워요.',
      tip: '외우기 꿀팁: 시간 단위(초·시간·일) 변환만 꼼꼼히 챙겨도 상하수도 계산 문제는 절반 이상 맞혀요!'
    }
  };

  function stripHtml(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<img[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------- Detect Negative Questions ("옳지 않은 것은?") ---------------- */
  function isNegativeQuestion(qStem) {
    const plain = stripHtml(qStem);
    return /(옳지\s*않은|틀린\s*것|아닌\s*것|적당하지\s*않|적합하지\s*않|부적합|부적당|잘못\s*설명|잘못된|맞지\s*않|거리가\s*먼|관계가\s*먼|관계가\s*없는|관련이\s*없는|해당하지\s*않|해당되지\s*않|사용되지\s*않|볼\s*수\s*없는|할\s*수\s*없는|가장\s*적은\s*것은.*오답)/.test(plain);
  }

  /* ---------------- Friendly Korean Tone Converter ---------------- */
  function toFriendlyKorean(text) {
    if (!text) return '';
    let s = String(text).trim();

    // Protect LaTeX blocks from accidental Korean string replacements
    const mathSlots = [];
    s = s.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$]+?\$/g, (m) => {
      mathSlots.push(m);
      return `@@MATH${mathSlots.length - 1}@@`;
    });

    // Make stiff textbook endings warm & kid-friendly
    const REPLACEMENTS = [
      [/구할 수 있습니다\./g, '구할 수 있어요.'],
      [/계산할 수 있습니다\./g, '계산할 수 있어요.'],
      [/판별할 수 있습니다\./g, '쉽게 알 수 있어요.'],
      [/보정할 수 있습니다\./g, '고칠 수 있어요.'],
      [/계산합니다\./g, '계산해요.'],
      [/산출합니다\./g, '구해요.'],
      [/도출됩니다\./g, '나와요.'],
      [/적용합니다\./g, '사용해요.'],
      [/설치합니다\./g, '설치해요.'],
      [/사용됩니다\./g, '쓰여요.'],
      [/사용합니다\./g, '써요.'],
      [/발생합니다\./g, '생겨요.'],
      [/나타납니다\./g, '나타나요.'],
      [/나타냅니다\./g, '뜻해요.'],
      [/의미합니다\./g, '뜻이에요.'],
      [/결정합니다\./g, '정해요.'],
      [/규정하고 있습니다\./g, '정해져 있어요.'],
      [/가집니다\./g, '갖고 있어요.'],
      [/존재합니다\./g, '있어요.'],
      [/성립합니다\./g, '성립해요.'],
      [/동일해집니다\./g, '똑같아져요.'],
      [/동일합니다\./g, '똑같아요.'],
      [/적당하지 않습니다\./g, '어울리지 않아요.'],
      [/적합하지 않습니다\./g, '맞지 않아요.'],
      [/불가능합니다\./g, '할 수 없어요.'],
      [/가능합니다\./g, '할 수 있어요.'],
      [/필요합니다\./g, '필요해요.'],
      [/중요합니다\./g, '중요해요.'],
      [/유리합니다\./g, '더 좋아요(유리해요).'],
      [/불리합니다\./g, '안 좋아요(불리해요).'],
      [/경향이 있습니다\./g, '경향이 있어요.'],
      [/위함입니다\./g, '위해서예요.'],
      [/때문입니다\./g, '때문이에요.'],
      [/문제입니다\./g, '문제예요.'],
      [/이론입니다\./g, '이론이에요.'],
      [/방법입니다\./g, '방법이에요.'],
      [/종류입니다\./g, '종류예요.'],
      [/특성입니다\./g, '특징이에요.'],
      [/상태입니다\./g, '상태예요.'],
      [/값입니다\./g, '값이에요.'],
      [/됩니다\./g, '돼요.'],
      [/입니다\./g, '예요.'],
      [/합니다\./g, '해요.'],
      [/있습니다\./g, '있어요.'],
      [/없습니다\./g, '없어요.'],
      [/큽니다\./g, '커요.'],
      [/작습니다\./g, '작아요.'],
      [/같습니다\./g, '같아요.'],
      [/높습니다\./g, '높아요.'],
      [/낮습니다\./g, '낮아요.'],
      [/않습니다\./g, '않아요.'],
      [/\b따라서\b/g, '그래서'],
      [/\b그러므로\b/g, '그래서'],
      [/\b그러나\b/g, '하지만'],
      [/\b다만,\s*/g, '참고로 '],
      [/\b즉,\s*/g, '쉽게 말해 '],
      [/\b이는\b/g, '이것은'],
      [/\b산출하고\b/g, '구하고'],
      [/\b산출하여\b/g, '구해서'],
      [/\b적용하여\b/g, '써서'],
      [/\b이용하여\b/g, '이용해서'],
      [/\b고려하여\b/g, '따져 보면']
    ];
    for (const [rx, rep] of REPLACEMENTS) {
      s = s.replace(rx, rep);
    }

    // Restore LaTeX blocks
    s = s.replace(/@@MATH(\d+)@@/g, (_, idx) => mathSlots[Number(idx)]);
    return s;
  }

  /* ---------------- Match Best Concept Card ---------------- */
  function matchConcept(q) {
    const bank = window.CBT_CONCEPTS?.CONCEPTS || [];
    const stemLow = stripHtml(q.q).toLowerCase();
    const expLow = stripHtml(q.e).toLowerCase();
    const ansChoiceLow = stripHtml(q.c[q.a - 1] || '').toLowerCase();
    const allChoicesLow = q.c.map(stripHtml).join(' ').toLowerCase();

    let best = null;
    let bestScore = 0;

    for (const item of bank) {
      if (item.s !== 0 && item.s !== q.s) continue;
      let score = 0;
      for (const kw of item.kw) {
        const k = kw.toLowerCase();
        if (stemLow.includes(k)) score += 4 + Math.min(3, k.length * 0.35);
        if (ansChoiceLow.includes(k)) score += 3;
        if (expLow.includes(k)) score += 2.5;
        if (allChoicesLow.includes(k)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    if (best && bestScore >= 2.5) return best;
    return SUBJECT_FALLBACKS[q.s] || SUBJECT_FALLBACKS[1];
  }

  /* ---------------- Extract Matching Terms & Symbols for THIS Question ---------------- */
  function extractVocabAndSymbols(q) {
    const combined = `${stripHtml(q.q)} ${stripHtml(q.e)} ${q.c.map(stripHtml).join(' ')}`;
    const rawMathSource = `${q.q} ${q.e}`;

    // 1. Terms (pre-sorted longest first, deduplicate)
    const foundTerms = [];
    const seenTermKey = new Set();
    for (const t of SORTED_TERMS) {
      if (t.s !== 0 && t.s !== q.s) continue;
      if (combined.includes(t.term)) {
        const key = t.term.replace(/\s+/g, '');
        if (seenTermKey.has(key)) continue;
        if (foundTerms.some((f) => f.label.replace(/\s+/g, '').includes(key))) continue;
        seenTermKey.add(key);
        foundTerms.push({ kind: 'term', label: t.term, desc: t.simple });
        if (foundTerms.length >= 4) break;
      }
    }

    // 2. Symbols present inside math blocks (using pre-compiled RegExp!)
    const mathOnly = (rawMathSource.match(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$]+?\$/g) || []).join(' ');
    const foundSymbols = [];
    const seenSym = new Set();
    if (mathOnly) {
      for (const sym of COMPILED_SYMBOLS) {
        if (!sym.s.includes(0) && !sym.s.includes(q.s)) continue;
        if (seenSym.has(sym.label)) continue;
        if (sym.re.test(mathOnly)) {
          seenSym.add(sym.label);
          foundSymbols.push({ kind: 'sym', label: sym.label, desc: sym.desc });
          if (foundSymbols.length >= 4) break;
        }
      }
    }

    return { terms: foundTerms, symbols: foundSymbols };
  }

  /* ---------------- Extract Given Conditions / Hints from Question Stem ---------------- */
  function extractGivenHints(qStem) {
    const plain = stripHtml(qStem);
    const hints = [];

    // 1. Pull "(단, ...)" parenthetical condition
    const danMatch = plain.match(/\(\s*단\s*[,，.]?\s*([^)]+)\)/);
    if (danMatch && danMatch[1].trim().length >= 3) {
      const parts = danMatch[1].split(/[,，;]/).map((x) => x.trim()).filter(Boolean);
      for (const p of parts) {
        hints.push(p.replace(/이다\.?$|한다\.?$|로\s*한다\.?$/, '').trim());
      }
    }

    // 2. Pull explicit "변수 = 숫자단위" patterns outside "(단, ...)"
    const mainPart = plain.replace(/\(\s*단[^)]*\)/g, '');
    const assignMatches = mainPart.match(/[가-힣A-Za-z][가-힣A-Za-z0-9_]{0,8}\s*[=＝]\s*-?[0-9,\.]+(?:\s*[×xX]\s*10\^-?\d+)?\s*(?:mm\^?\d?|cm\^?\d?|km\^?\d?|m\^?\d?(?:\/[a-zA-Z·∙]+)?|kgf?\/cm\^?2?|kN(?:\/m\^?\d?|[·∙]m)?|MPa|kPa|kW|t(?:\/m\^?\d?|[·∙]m)?|%|°|명|시간|분|초|일|m|L|ℓ)?/g) || [];
    for (const am of assignMatches) {
      const clean = am.trim();
      if (clean.length >= 3 && !hints.some((h) => h.includes(clean))) {
        hints.push(clean);
      }
    }

    // 3. Pull natural Korean numeric phrases like "수심이 4m", "체류시간이 1시간", "인구가 10000명"
    if (hints.length < 2) {
      const korNums = mainPart.match(/[가-힣]{2,7}(?:이|가|은|는|의)?\s+[0-9,\.]+(?:\s*[×x]\s*10\^-?\d+)?\s*(?:mm|cm|km|m³\/d|m3\/d|m\/s|m\/sec|m|kg|kN|t|MPa|kPa|%|°|도|시간|분|초|년|일|명|대|개|배|ℓ\/sec)/g) || [];
      for (const kn of korNums) {
        const clean = kn.replace(/(?:이|가|은|는)\s+/, ' = ').trim();
        if (!hints.some((h) => h.includes(clean))) hints.push(clean);
      }
    }

    return hints.slice(0, 6);
  }

  /* ---------------- Parse Original Explanation into Clean Structured Sections ---------------- */
  function parseOriginalExplanation(expHtml) {
    const raw = String(expHtml || '').trim();
    if (!raw) return { intro: '', formula: '', sub: '', result: '', extraLines: [], wrongNotes: [], isCalc: false };

    // Separate [오답 노트] section if present
    let mainPart = raw;
    let wrongNotes = [];
    const wnSplit = raw.split(/<br>\s*<b>\s*\[?오답\s*노트\]?\s*<\/b>\s*<br>?|<b>\s*\[?오답\s*노트\]?\s*<\/b>\s*<br>?/i);
    if (wnSplit.length > 1) {
      mainPart = wnSplit[0];
      wrongNotes = wnSplit.slice(1).join('<br>')
        .split(/<br\s*\/?>/i)
        .map((x) => x.replace(/<\/?[^>]+>/g, '').trim())
        .filter((x) => x.length > 1);
    }

    const lines = mainPart
      .split(/<br\s*\/?>/i)
      .map((l) => l.trim())
      .filter(Boolean);

    let intro = [];
    let formula = [];
    let sub = [];
    let result = [];
    let extraLines = [];
    let currentBucket = 'intro';

    for (const line of lines) {
      if (/①\s*\[기본\s*공식\]|\[기본\s*공식\]/.test(line)) {
        currentBucket = 'formula';
        const rest = line.replace(/①\s*\[기본\s*공식\]|\[기본\s*공식\]/, '').trim();
        if (rest) formula.push(rest);
      } else if (/②\s*\[숫자\s*대입\]|②\s*\[식\s*대입\]|\[숫자\s*대입\]/.test(line)) {
        currentBucket = 'sub';
        const rest = line.replace(/②\s*\[숫자\s*대입\]|②\s*\[식\s*대입\]|\[숫자\s*대입\]/, '').trim();
        if (rest) sub.push(rest);
      } else if (/③\s*\[최종\s*결과\]|\[최종\s*결과\]/.test(line)) {
        currentBucket = 'result';
        const rest = line.replace(/③\s*\[최종\s*결과\]|\[최종\s*결과\]/, '').trim();
        if (rest) result.push(rest);
      } else {
        if (currentBucket === 'formula') formula.push(line);
        else if (currentBucket === 'sub') sub.push(line);
        else if (currentBucket === 'result') result.push(line);
        else intro.push(line);
      }
    }

    // If explanation didn't have ①②③ markers but has standalone math blocks (like 20220424-1!)
    if (!formula.length && !sub.length && intro.length > 1) {
      const pureMathLines = [];
      const textLines = [];
      for (const l of intro) {
        if (/^\s*(\$\$[\s\S]+\$\$|\$[^$]+\$|①|②|③)/.test(l) && /\$/.test(l)) {
          pureMathLines.push(l);
        } else {
          textLines.push(l);
        }
      }
      if (pureMathLines.length >= 2) {
        intro = textLines;
        // First symbolic formula vs numeric lines vs final line
        const hasVars = /[A-Za-z\\]/.test(pureMathLines[0].replace(/\\times|\\cdot|\\frac|\\text\{[^}]*\}/g, ''));
        if (hasVars && pureMathLines.length >= 3) {
          formula = [pureMathLines[0]];
          sub = pureMathLines.slice(1, -1);
          result = [pureMathLines[pureMathLines.length - 1]];
        } else {
          sub = pureMathLines.slice(0, -1);
          result = [pureMathLines[pureMathLines.length - 1]];
        }
      }
    }

    const isCalc = Boolean(formula.length || sub.length || /\\frac|\\sqrt|\\times|①\s*\[기본/.test(mainPart));

    return {
      intro: intro.join('<br>'),
      formula: formula.join('<br>'),
      sub: sub.join('<br>'),
      result: result.join('<br>'),
      extraLines,
      wrongNotes,
      isCalc
    };
  }

  /* ---------------- Translate a Formula Line into Plain Korean Words ---------------- */
  function formulaToPlainKorean(formulaHtml) {
    if (!formulaHtml || !window.CBT_TTS) return '';
    const spoken = window.CBT_TTS.mathToKoreanSpeech(formulaHtml);
    if (!spoken || spoken.length < 4) return '';
    return spoken;
  }

  /* ---------------- Build Complete Easy Explanation Object ---------------- */
  function build(q, subjectName) {
    if (buildCache.has(q.i)) return buildCache.get(q.i);
    const neg = isNegativeQuestion(q.q);
    const hasImg = /<img/i.test(q.q);
    const concept = matchConcept(q);
    const vocab = extractVocabAndSymbols(q);
    const hints = extractGivenHints(q.q);
    const parsed = parseOriginalExplanation(q.e);
    const verifiedSteps = Array.isArray(q.st) ? q.st : [];
    const ansChoiceHtml = q.c[q.a - 1] || '';
    const ansChoicePlain = stripHtml(ansChoiceHtml);
    const ansNumLabel = `${CIRCLED[q.a]}번`;

    // Build friendly one-line "What is this problem asking?"
    let goalLine = '';
    if (neg) {
      goalLine = `이 문제는 4개의 보기 중에서 <strong>틀린 설명(맞지 않는 것) 1개</strong>를 찾아내는 문제예요!`;
    } else if (parsed.isCalc) {
      goalLine = `이 문제는 <strong>${subjectName}</strong>의 핵심 공식을 이용해서 정확한 숫자를 계산하는 문제예요!`;
    } else {
      goalLine = `이 문제는 <strong>${subjectName}</strong>의 기본 원리를 이해하고 <strong>올바른 설명</strong>을 고르는 문제예요!`;
    }

    // Build step-by-step easy walkthrough blocks
    const walkSteps = [];

    if (parsed.isCalc) {
      // Step 1: Intro + Given Hints
      const introFriendly = toFriendlyKorean(parsed.intro);
      if (hints.length > 0) {
        walkSteps.push({
          num: '1단계',
          title: '문제에서 준 힌트(숫자)부터 챙기기',
          bodyHtml: (introFriendly ? `<p class="easy-p">${introFriendly}</p>` : '') +
            `<div class="easy-hints-list">${hints.map((h) => `<span class="easy-hint-pill">📌 ${escapeHtml(h)}</span>`).join('')}</div>` +
            (hasImg ? `<div class="easy-img-tip">🖼️ 위 도면(그림)을 클릭하면 크게 확대해서 치수를 편하게 볼 수 있어요!</div>` : ''),
          speech: (introFriendly || '먼저 문제에서 알려준 숫자를 챙겨 볼게요.') + (hints.length ? ' 주어진 조건은 ' + hints.join(', ') + ' 입니다.' : '')
        });
      } else if (introFriendly) {
        walkSteps.push({
          num: '1단계',
          title: '어떻게 풀지 방향 잡기',
          bodyHtml: `<p class="easy-p">${introFriendly}</p>` +
            (hasImg ? `<div class="easy-img-tip">🖼️ 위 도면(그림)을 클릭하면 크게 확대해서 치수를 편하게 볼 수 있어요!</div>` : ''),
          speech: introFriendly
        });
      }

      // Step 2: Formula + Plain-Korean Translation
      if (parsed.formula) {
        const plainFormula = formulaToPlainKorean(parsed.formula);
        walkSteps.push({
          num: `${walkSteps.length + 1}단계`,
          title: '사용할 공식, 쉬운 말로 이해하기',
          bodyHtml: `<div class="easy-math-box">${parsed.formula}</div>` +
            (plainFormula ? `<div class="easy-formula-trans">💬 <strong>말로 읽으면:</strong> ${escapeHtml(plainFormula)}</div>` : ''),
          speech: `공식을 쉬운 말로 풀어볼게요. ${plainFormula || parsed.formula}.`
        });
      }

      // Step 3: Substitution + Verified Elementary Arithmetic Steps!
      if (parsed.sub || verifiedSteps.length > 0) {
        let calcHtml = '';
        if (parsed.sub) {
          calcHtml += `<div class="easy-math-box">${parsed.sub}</div>`;
        }
        let stepSpeech = '';
        if (verifiedSteps.length > 0) {
          calcHtml += `<div class="easy-arith-box">
            <div class="easy-arith-head">🧮 초등학생처럼 한 줄씩 천천히 계산해 보기</div>
            <ol class="easy-arith-list">
              ${verifiedSteps.map((st) => `<li>${escapeHtml(st)}</li>`).join('')}
            </ol>
          </div>`;
          // Turn arithmetic steps into warm, naturally connected Korean sentences!
          const connectors = ['먼저 ', '다음으로 ', '이어서 ', '그리고 ', '그다음 ', '또 ', '이제 '];
          const smoothLines = verifiedSteps.map((st, idx) => {
            const exprOnly = st.replace(/^[^:]+:\s*/, '').trim();
            const isLast = idx === verifiedSteps.length - 1;
            const prefix = isLast && verifiedSteps.length > 1 ? '마지막으로 ' : (connectors[idx] || '이어서 ');
            return `${prefix}${exprOnly}${isLast ? '이 나와요.' : '이고요,'}`;
          });
          stepSpeech = `차근차근 계산해 볼게요. ${smoothLines.join(' ')}`;
        } else if (parsed.sub) {
          stepSpeech = `공식에 숫자를 그대로 넣어 계산하면, ${formulaToPlainKorean(parsed.sub)}이 됩니다.`;
        }
        walkSteps.push({
          num: `${walkSteps.length + 1}단계`,
          title: '숫자 넣고 차근차근 계산하기',
          bodyHtml: calcHtml,
          speech: stepSpeech
        });
      }

      // Step 4: Final result & choice match
      const resultHtml = parsed.result ? `<div class="easy-math-box easy-result-box">${toFriendlyKorean(parsed.result)}</div>` : '';
      const choiceTextHtml = ansChoiceHtml
        ? `<div class="easy-final-answer">👉 그래서 정답은 <strong>${ansNumLabel}</strong>${ansChoicePlain ? ` (${ansChoiceHtml})` : ''}이에요!</div>`
        : `<div class="easy-final-answer">👉 그래서 정답은 <strong>${ansNumLabel}</strong>이에요!</div>`;
      walkSteps.push({
        num: `${walkSteps.length + 1}단계`,
        title: '최종 정답 확인하기',
        bodyHtml: resultHtml + choiceTextHtml,
        speech: (parsed.result ? `계산한 최종 결과는 ${formulaToPlainKorean(parsed.result)} 이고, ` : '') +
          `따라서 정답은 ${ansNumLabel}${ansChoicePlain ? ', ' + ansChoicePlain : ''} 입니다.`
      });
    } else {
      // Concept / Theory question: Break down warmly!
      const rawSentences = (parsed.intro || q.e || '')
        .split(/<br\s*\/?>/i)
        .map((s) => s.trim())
        .filter(Boolean);

      const friendlyLines = rawSentences.map((line) => toFriendlyKorean(line));

      // Step 1: Why the winning choice is the answer
      walkSteps.push({
        num: '1단계',
        title: neg ? `왜 ${ansNumLabel}이 틀린 설명(정답)일까요?` : `왜 ${ansNumLabel}이 정답일까요?`,
        bodyHtml: (ansChoiceHtml ? `<div class="easy-choice-quote"><span class="easy-quote-tag">${neg ? '❌ 틀린 보기 (정답)' : '✅ 정답 보기'}</span><span>${CIRCLED[q.a]} ${ansChoiceHtml}</span></div>` : '') +
          friendlyLines.map((fl) => `<p class="easy-p">${fl}</p>`).join('') +
          (hasImg ? `<div class="easy-img-tip">🖼️ 위 도면(그림)을 클릭하면 크게 확대해서 자세히 볼 수 있어요!</div>` : ''),
        speech: (neg ? `이 문제는 틀린 설명을 고르는 문제예요. ` : '') +
          `정답은 ${ansNumLabel}${ansChoicePlain ? ', ' + ansChoicePlain : ''} 입니다. ` +
          friendlyLines.join(' ')
      });
    }

    // Wrong-notes / other choices breakdown
    let wrongNoteItems = [];
    if (parsed.wrongNotes.length > 0) {
      wrongNoteItems = parsed.wrongNotes.map((line) => {
        const friendly = toFriendlyKorean(line);
        const colonIdx = friendly.indexOf(':');
        if (colonIdx > 0 && colonIdx < 28) {
          return {
            head: friendly.slice(0, colonIdx).trim(),
            body: friendly.slice(colonIdx + 1).trim(),
            raw: friendly
          };
        }
        return { head: '', body: friendly, raw: friendly };
      });
    }

    // ---------------- Build Rich Rendered HTML ----------------
    const allVocab = [...vocab.terms, ...vocab.symbols];

    let html = `<div class="easy-wrap">`;

    // Negative question alert banner
    if (neg) {
      html += `<div class="easy-alert-neg">⚠️ <strong>함정 주의!</strong> 이 문제는 맞는 말이 아니라 <strong>'틀린 보기(아닌 것)'</strong>를 고르는 문제예요!</div>`;
    }

    // Section 1: Analogy & Core Intuition
    html += `
      <section class="easy-card easy-card-analogy" data-tts-seg="seg-analogy">
        <div class="easy-card-head">
          <span class="easy-card-emoji">${concept.emoji || '💡'}</span>
          <div>
            <div class="easy-card-kicker">초등학생 눈높이 쉬운 비유</div>
            <div class="easy-card-title">${escapeHtml(concept.title)}</div>
          </div>
        </div>
        <p class="easy-goal-line">${goalLine}</p>
        <p class="easy-analogy-text">${escapeHtml(concept.analogy)}</p>
      </section>
    `;

    // Section 2: Hard Words & Symbols Mini-Dictionary
    if (allVocab.length > 0) {
      html += `
        <section class="easy-card easy-card-vocab" data-tts-seg="seg-vocab">
          <div class="easy-card-head compact">
            <span class="easy-card-emoji">🧩</span>
            <div class="easy-card-title">어려운 단어 · 기호 먼저 알고 가기</div>
          </div>
          <div class="easy-vocab-grid">
            ${allVocab.map((v) => `
              <div class="easy-vocab-chip ${v.kind === 'sym' ? 'is-sym' : ''}">
                <span class="easy-vocab-term">${escapeHtml(v.label)}</span>
                <span class="easy-vocab-desc">${escapeHtml(v.desc)}</span>
              </div>
            `).join('')}
          </div>
        </section>
      `;
    }

    // Section 3: Step-by-Step Walkthrough
    html += `
      <section class="easy-card easy-card-steps" data-tts-seg="seg-steps">
        <div class="easy-card-head compact">
          <span class="easy-card-emoji">✏️</span>
          <div class="easy-card-title">차근차근 따라 푸는 쉬운 풀이</div>
        </div>
        <div class="easy-steps-list">
          ${walkSteps.map((st, idx) => `
            <div class="easy-step-item" data-tts-seg="seg-step-${idx}">
              <div class="easy-step-head">
                <span class="easy-step-badge">${escapeHtml(st.num)}</span>
                <span class="easy-step-title">${escapeHtml(st.title)}</span>
              </div>
              <div class="easy-step-body">${st.bodyHtml}</div>
            </div>
          `).join('')}
        </div>
      </section>
    `;

    // Section 4: Wrong-note / Other Choices Check
    if (wrongNoteItems.length > 0) {
      html += `
        <section class="easy-card easy-card-wrong" data-tts-seg="seg-wrongnote">
          <div class="easy-card-head compact">
            <span class="easy-card-emoji">📌</span>
            <div class="easy-card-title">${neg ? '나머지 보기가 맞는 이유도 확인해요!' : '헷갈리기 쉬운 다른 보기 포인트'}</div>
          </div>
          <ul class="easy-wn-list">
            ${wrongNoteItems.map((it) => it.head
              ? `<li><strong>${escapeHtml(it.head)}:</strong> ${escapeHtml(it.body)}</li>`
              : `<li>${escapeHtml(it.body)}</li>`
            ).join('')}
          </ul>
        </section>
      `;
    }

    // Section 5: 10-Second Summary & Memory Tip
    html += `
      <section class="easy-card easy-card-tip" data-tts-seg="seg-tip">
        <div class="easy-card-head compact">
          <span class="easy-card-emoji">🧠</span>
          <div class="easy-card-title">10초 요약 &amp; 암기 꿀팁</div>
        </div>
        <p class="easy-rule-text"><strong>핵심 규칙:</strong> ${escapeHtml(concept.rule)}</p>
        <p class="easy-tip-text">✨ ${escapeHtml(concept.tip)}</p>
      </section>
    `;

    html += `</div>`;

    // ---------------- Build Warm, Naturally Flowing Korean Speech Script ----------------
    const speechSegments = [];

    speechSegments.push({
      id: 'seg-analogy',
      text: `정답은 ${ansNumLabel}${ansChoicePlain ? ', ' + ansChoicePlain : ''}이에요. ${concept.analogy}`
    });

    walkSteps.forEach((st, idx) => {
      if (parsed.isCalc && idx === 0 && walkSteps.length >= 3 && hints.length > 0) return;
      speechSegments.push({
        id: `seg-step-${idx}`,
        text: `${st.speech}`
      });
    });

    const cleanTip = String(concept.tip || '').replace(/^외우기\s*꿀팁\s*:\s*/, '');
    speechSegments.push({
      id: 'seg-tip',
      text: `마지막으로 꼭 기억해 둘 꿀팁이에요. ${cleanTip}`
    });

    const out = {
      html,
      speechSegments,
      concept,
      isNegative: neg,
      isCalc: parsed.isCalc
    };
    buildCache.set(q.i, out);
    return out;
  }

  /* ---------------- Build Question + 4 Choices Speech Segments ---------------- */
  function buildQuestionSpeech(q, qDisplayNum, subjectName) {
    const segs = [];
    const stemPlain = stripHtml(q.q);
    segs.push({
      id: 'q-stem',
      text: `${qDisplayNum}번 문제, ${subjectName}입니다. ${stemPlain}`
    });
    const choiceParts = q.c.map((cHtml, i) => {
      const plain = stripHtml(cHtml);
      return `${i + 1}번, ${plain || '그림 보기'}`;
    });
    segs.push({
      id: 'q-choices',
      text: `보기를 읽어드릴게요. ${choiceParts.join('. ')}.`
    });
    return segs;
  }

  return {
    build,
    buildQuestionSpeech,
    stripHtml,
    toFriendlyKorean
  };
})();
