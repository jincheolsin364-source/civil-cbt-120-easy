(() => {
  'use strict';

  const INDEX = window.CBT_INDEX;
  const EASY = window.CBT_EASY;
  const TTS = window.CBT_TTS;
  const CONCEPTS = window.CBT_CONCEPTS;

  if (!INDEX || !Array.isArray(INDEX.sessions)) {
    alert('문제 인덱스(data/index.js)를 불러오지 못했습니다.');
    return;
  }

  const STORAGE_KEYS = {
    wrong: 'civil_cbt_easy_wrong_ids_v1',
    bookmarks: 'civil_cbt_easy_bookmarks_v1',
    session: 'civil_cbt_easy_active_session_v1',
    theme: 'civil_cbt_easy_theme_v1',
    autoNext: 'civil_cbt_easy_autonext_v1',
    expTab: 'civil_cbt_easy_exptab_v1'
  };

  const CIRCLED = ['', '①', '②', '③', '④'];
  const validSessionSet = new Set(INDEX.sessions.map((s) => s.y));

  /* ---------------- Ultra-Fast On-Demand Data Loader & In-Memory Cache ---------------- */
  const byId = new Map();
  const sessionCache = new Map();     // ymd -> Question[]
  const sessionPromises = new Map();  // ymd -> Promise<Question[]>
  const subjectCache = new Map();     // 1..6 -> Question[]
  const subjectPromises = new Map();
  let searchIndexCache = null;

  function registerQuestions(list) {
    for (const q of list) {
      if (!byId.has(q.i)) byId.set(q.i, q);
    }
  }

  async function ensureSession(ymd) {
    if (sessionCache.has(ymd)) return sessionCache.get(ymd);
    if (sessionPromises.has(ymd)) return sessionPromises.get(ymd);
    const p = fetch(`./data/sessions/${ymd}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((qs) => {
        sessionCache.set(ymd, qs);
        registerQuestions(qs);
        return qs;
      })
      .finally(() => sessionPromises.delete(ymd));
    sessionPromises.set(ymd, p);
    return p;
  }

  async function ensureSessions(ymdList) {
    const uniq = Array.from(new Set(ymdList.filter((y) => validSessionSet.has(y))));
    const lists = await Promise.all(uniq.map((y) => ensureSession(y)));
    return lists.flat();
  }

  async function ensureQuestionsByIds(qIds) {
    const neededSessions = [];
    for (const id of qIds) {
      if (!byId.has(id) && typeof id === 'string' && id.includes('-')) {
        neededSessions.push(id.split('-')[0]);
      }
    }
    if (neededSessions.length > 0) {
      await ensureSessions(neededSessions);
    }
    return qIds.filter((id) => byId.has(id));
  }

  async function ensureSubject(sNum) {
    if (subjectCache.has(sNum)) return subjectCache.get(sNum);
    if (subjectPromises.has(sNum)) return subjectPromises.get(sNum);
    const p = fetch(`./data/subjects/s${sNum}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((qs) => {
        subjectCache.set(sNum, qs);
        registerQuestions(qs);
        return qs;
      })
      .finally(() => subjectPromises.delete(sNum));
    subjectPromises.set(sNum, p);
    return p;
  }

  async function ensureSearchIndex() {
    if (searchIndexCache) return searchIndexCache;
    const res = await fetch('./data/search_index.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    searchIndexCache = await res.json();
    return searchIndexCache;
  }

  function loadSet(key) {
    try {
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      return new Set(Array.isArray(arr) ? arr.filter((id) => typeof id === 'string' && id.includes('-')) : []);
    } catch { return new Set(); }
  }
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch {}
  }

  const wrongIds = loadSet(STORAGE_KEYS.wrong);
  const bookmarkIds = loadSet(STORAGE_KEYS.bookmarks);

  let selectedMode = 'practice';
  let subjectPickCount = 20;
  let activeQuiz = null;
  let activeEasyData = null;
  let activeExpTab = localStorage.getItem(STORAGE_KEYS.expTab) || 'easy';
  let timerHandle = null;
  let autoNextTimeout = null;
  let deferredPrompt = null;
  let glossarySubjectFilter = 0;

  const $ = (id) => document.getElementById(id);
  const screenHome = $('screenHome');
  const screenQuiz = $('screenQuiz');
  const screenResult = $('screenResult');

  let loadingTimer = null;
  function showLoading(msg = '불러오는 중...') {
    // Only show toast if loading takes > 120ms so instant loads never flash!
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => {
      $('loadingToastText').textContent = msg;
      $('loadingToast').classList.remove('hidden');
    }, 120);
  }
  function hideLoading() {
    clearTimeout(loadingTimer);
    $('loadingToast').classList.add('hidden');
  }

  /* ---------------- Theme ---------------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $('btnTheme').textContent = theme === 'dark' ? '☀️ 라이트' : '🌙 다크';
    try { localStorage.setItem(STORAGE_KEYS.theme, theme); } catch {}
  }
  applyTheme(localStorage.getItem(STORAGE_KEYS.theme) || 'light');
  $('btnTheme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  /* ---------------- Toggles ---------------- */
  const chkAutoNext = $('chkAutoNext');
  chkAutoNext.checked = localStorage.getItem(STORAGE_KEYS.autoNext) === '1';
  chkAutoNext.addEventListener('change', () => {
    try { localStorage.setItem(STORAGE_KEYS.autoNext, chkAutoNext.checked ? '1' : '0'); } catch {}
  });

  const chkAutoRead = $('chkAutoRead');
  const chkAutoReadModal = $('chkAutoReadModal');
  function syncAutoReadUI(val) {
    chkAutoRead.checked = val;
    chkAutoReadModal.checked = val;
  }
  syncAutoReadUI(TTS.getAutoRead());
  chkAutoRead.addEventListener('change', () => {
    TTS.setAutoRead(chkAutoRead.checked);
    syncAutoReadUI(chkAutoRead.checked);
  });
  chkAutoReadModal.addEventListener('change', () => {
    TTS.setAutoRead(chkAutoReadModal.checked);
    syncAutoReadUI(chkAutoReadModal.checked);
  });

  /* ---------------- PWA Install ---------------- */
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('btnInstallPwa').classList.remove('hidden');
  });
  $('btnInstallPwa').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('btnInstallPwa').classList.add('hidden');
  });

  /* ---------------- Helpers ---------------- */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function formatYmd(ymd) {
    if (!ymd || ymd.length !== 8) return ymd || '';
    return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  /* ---------------- Defense-in-Depth Allowlist HTML Sanitizer (DOM XSS Guard) ---------------- */
  const ALLOWED_TAGS = new Set([
    'BR', 'P', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SUB', 'SUP',
    'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'UL', 'OL', 'LI',
    'CODE', 'PRE', 'SMALL', 'HR', 'MARK', 'H3', 'H4', 'CAPTION'
  ]);
  const ALLOWED_ATTRS = new Set([
    'class', 'src', 'alt', 'title', 'colspan', 'rowspan', 'width', 'height',
    'data-tts-seg', 'style', 'loading', 'decoding', 'referrerpolicy'
  ]);
  const SAFE_IMG_SRC_RE = /^(?:(?:\.\/)?images\/[A-Za-z0-9_/-]+\.(?:png|webp|jpg|jpeg|gif|svg)|https:\/\/cbtbank\.kr\/[^\s"'<>]+|data:image\/(?:png|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+)$/i;

  function sanitizeHtml(dirty) {
    if (!dirty) return '';
    const str = String(dirty);
    if (!str.includes('<')) return str;
    try {
      const doc = new DOMParser().parseFromString(`<div>${str}</div>`, 'text/html');
      const root = doc.body.firstElementChild;
      if (!root) return '';
      const walk = (node) => {
        const children = Array.from(node.childNodes);
        for (const child of children) {
          if (child.nodeType === 1) { // Element
            const tag = child.tagName.toUpperCase();
            if (!ALLOWED_TAGS.has(tag)) {
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') {
                child.remove();
              } else {
                // Unwrap unknown non-dangerous wrapper tags safely
                walk(child);
                while (child.firstChild) node.insertBefore(child.firstChild, child);
                child.remove();
              }
              continue;
            }
            for (const attr of Array.from(child.attributes)) {
              const name = attr.name.toLowerCase();
              const val = attr.value || '';
              if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
                child.removeAttribute(attr.name);
              } else if (name === 'src') {
                if (tag !== 'IMG' || !SAFE_IMG_SRC_RE.test(val.trim())) {
                  child.removeAttribute('src');
                }
              } else if (name === 'style') {
                if (/expression|url\s*\(|javascript:|@import|behavior/i.test(val)) {
                  child.removeAttribute('style');
                }
              }
            }
            walk(child);
          } else if (child.nodeType === 8) { // Comment
            child.remove();
          }
        }
      };
      walk(root);
      return root.innerHTML;
    } catch {
      return str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }

  const KATEX_OPTS = {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false }
    ],
    throwOnError: false,
    strict: false
  };

  function renderMath(el) {
    if (!el) return;
    // Skip KaTeX work completely if element contains zero math delimiters!
    const txt = el.textContent || '';
    if (!txt.includes('$') && !txt.includes('\\(') && !txt.includes('\\[')) return;
    if (typeof window.renderMathInElement === 'function') {
      try { window.renderMathInElement(el, KATEX_OPTS); } catch {}
    } else {
      setTimeout(() => {
        if (typeof window.renderMathInElement === 'function') {
          try { window.renderMathInElement(el, KATEX_OPTS); } catch {}
        }
      }, 250);
    }
  }

  function enhanceImages(container, allowZoom) {
    if (!container) return;
    container.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      img.decoding = 'async';
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.addEventListener('error', () => {
        if (!img.dataset.retried) {
          img.dataset.retried = '1';
          const base = img.src.split('?')[0];
          img.src = base + '?r=' + Date.now();
        }
      });
      if (allowZoom) {
        img.title = '클릭하면 도면을 크게 확대합니다';
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          $('zoomImg').src = img.src;
          $('zoomModal').classList.remove('hidden');
        });
      }
    });
  }

  $('zoomModal').addEventListener('click', () => $('zoomModal').classList.add('hidden'));

  function showScreen(name) {
    TTS.stop();
    screenHome.classList.toggle('hidden', name !== 'home');
    screenQuiz.classList.toggle('hidden', name !== 'quiz');
    screenResult.classList.toggle('hidden', name !== 'result');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (autoNextTimeout) { clearTimeout(autoNextTimeout); autoNextTimeout = null; }
  }

  function persistSession() {
    if (!activeQuiz || activeQuiz.isReview) return;
    try { localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(activeQuiz)); } catch {}
  }
  function clearSavedSession() {
    try { localStorage.removeItem(STORAGE_KEYS.session); } catch {}
  }

  /* ---------------- TTS UI Synchronization & Live Highlight ---------------- */
  function clearTtsHighlights() {
    document.querySelectorAll('.tts-speaking').forEach((el) => el.classList.remove('tts-speaking'));
  }

  function syncSpeedButtons(rateVal) {
    document.querySelectorAll('#ttsSpeedGroup .speed-chip, #modalSpeedRow .chip').forEach((btn) => {
      btn.classList.toggle('active', Math.abs(Number(btn.dataset.rate) - rateVal) < 0.06);
    });
  }
  syncSpeedButtons(TTS.getRate());

  TTS.subscribe((st) => {
    const btnExp = $('btnSpeakExp');
    const btnStop = $('btnStopExp');
    const btnIcon = $('ttsBtnIcon');
    const btnLabel = $('ttsBtnLabel');
    const wave = $('ttsWave');
    const pill = $('ttsStatusPill');
    const btnQ = $('btnSpeakQuestion');

    syncSpeedButtons(st.rate);
    clearTtsHighlights();

    const isNeural = st.engineMode === 'local-supertonic' || st.engineMode === 'browser-supertonic';
    const voiceTestStatus = $('voiceTestStatus');
    if (voiceTestStatus) {
      if (st.mode === 'glossary' && st.status === 'loading') {
        voiceTestStatus.textContent = st.loadingText || '다정한 여성 AI 음성 준비 중...';
        voiceTestStatus.classList.remove('hidden');
      } else if (st.mode === 'glossary' && st.status === 'playing') {
        voiceTestStatus.textContent = isNeural ? '🎀 다정한 AI 선생님이 읽는 중입니다...' : '🔊 브라우저 기본 음성으로 읽는 중입니다...';
        voiceTestStatus.classList.remove('hidden');
      } else {
        voiceTestStatus.classList.add('hidden');
      }
    }

    if (st.mode === 'question' && st.status !== 'idle') {
      btnQ.classList.add('playing');
      btnQ.textContent = st.status === 'loading'
        ? (st.loadingPct > 0 && st.loadingPct < 100 ? `⏳ AI음성 ${st.loadingPct}%` : '⏳ 준비 중...')
        : st.status === 'playing' ? '⏹ 문제 정지' : '▶ 이어듣기';
      if (st.activeSegId === 'q-stem') $('qStem')?.classList.add('tts-speaking');
    } else {
      btnQ.classList.remove('playing');
      btnQ.textContent = '🔈 문제 듣기';
    }

    if (st.mode === 'explanation' && st.status !== 'idle') {
      btnExp.classList.toggle('playing', st.status === 'playing' || st.status === 'loading');
      btnExp.classList.toggle('paused', st.status === 'paused');
      btnStop.classList.remove('hidden');
      pill.classList.remove('hidden');
      if (st.status === 'loading') {
        btnIcon.textContent = '✨';
        btnLabel.textContent = st.loadingPct > 0 && st.loadingPct < 100 ? `AI 음성 준비 (${st.loadingPct}%)` : '목소리 준비 중...';
        wave.classList.remove('hidden');
        pill.textContent = st.loadingText || '다정한 여성 AI 음성 생성 중';
      } else if (st.status === 'playing') {
        btnIcon.textContent = '⏸';
        btnLabel.textContent = '일시정지';
        wave.classList.remove('hidden');
        pill.textContent = isNeural ? '다정한 AI 선생님 읽는 중' : `읽는 중 (${st.currentIdx + 1}/${st.totalChunks})`;
      } else {
        btnIcon.textContent = '▶';
        btnLabel.textContent = '이어듣기';
        wave.classList.add('hidden');
        pill.textContent = '일시정지됨';
      }
      if (st.activeSegId) {
        const target = document.querySelector(`[data-tts-seg="${st.activeSegId}"]`);
        if (target) target.classList.add('tts-speaking');
      }
    } else {
      btnExp.classList.remove('playing', 'paused');
      btnIcon.textContent = '🔊';
      btnLabel.textContent = '음성으로 듣기';
      wave.classList.add('hidden');
      btnStop.classList.add('hidden');
      pill.classList.add('hidden');
    }
  });

  function playCurrentExplanation() {
    if (!activeQuiz) return;
    const st = TTS.getState();
    if (st.mode === 'explanation' && st.status !== 'idle') {
      TTS.togglePause();
      return;
    }
    const q = byId.get(activeQuiz.qIds[activeQuiz.cur]);
    if (!q) return;

    if (activeExpTab === 'easy' && activeEasyData && activeEasyData.speechSegments.length > 0) {
      TTS.speakSegments(activeEasyData.speechSegments, 'explanation');
    } else {
      const ansChoicePlain = EASY.stripHtml(q.c[q.a - 1] || '');
      TTS.speakSegments([
        { id: 'orig-exp', text: `정답은 ${q.a}번${ansChoicePlain ? ', ' + ansChoicePlain : ''}입니다. ${q.e || '등록된 해설이 없습니다.'}` }
      ], 'explanation');
    }
  }

  $('btnSpeakExp').addEventListener('click', playCurrentExplanation);
  $('btnStopExp').addEventListener('click', () => TTS.stop());

  $('btnSpeakQuestion').addEventListener('click', () => {
    if (!activeQuiz) return;
    const st = TTS.getState();
    if (st.mode === 'question' && st.status !== 'idle') {
      TTS.stop();
      return;
    }
    const q = byId.get(activeQuiz.qIds[activeQuiz.cur]);
    if (!q) return;
    const segs = EASY.buildQuestionSpeech(q, activeQuiz.cur + 1, INDEX.subjects[q.s - 1]);
    TTS.speakSegments(segs, 'question');
  });

  document.querySelectorAll('#ttsSpeedGroup .speed-chip, #modalSpeedRow .chip').forEach((btn) => {
    btn.addEventListener('click', () => TTS.setRate(Number(btn.dataset.rate)));
  });

  /* ---------------- Home Screen (Instant < 15ms Render!) ---------------- */
  function renderHome() {
    stopTimer();
    TTS.stop();
    const yrRange = INDEX.meta.yearRange || '2003~2026';
    $('dbMetaBadge').textContent = `${yrRange}년 ${INDEX.meta.sessions}회차 · ${INDEX.meta.total.toLocaleString()}문제 · 🌱 초등학생 쉬운 풀이 & 🔊 음성 듣기`;
    $('wrongCountBadge').textContent = wrongIds.size;
    $('bookmarkCountBadge').textContent = bookmarkIds.size;

    const newGrid = $('newExamsGrid');
    if (newGrid) {
      newGrid.innerHTML = '';
      const newSessions = INDEX.sessions.filter((s) => s.isNew || Number(s.yr) >= 2023);
      for (const s of newSessions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'new-exam-btn';
        btn.innerHTML = `
          <span class="new-exam-tag">${s.yr === 2026 ? 'NEW 모의고사' : 'NEW 기출'}</span>
          <div class="new-exam-title">${s.t}</div>
          <div class="new-exam-meta">전 6과목 · ${s.n}문제 · 쉬운 풀이 &amp; 도면 수록</div>
        `;
        btn.addEventListener('click', () => startSessionQuiz(s.y));
        newGrid.appendChild(btn);
      }
    }

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.session) || 'null'); } catch {}
    const resumeBanner = $('resumeBanner');
    if (saved && Array.isArray(saved.qIds) && saved.qIds.length > 0) {
      const answeredCount = Object.keys(saved.answers || {}).length;
      $('resumeText').textContent = `진행 중: ${saved.title} (${answeredCount} / ${saved.qIds.length}문항 풀이)`;
      resumeBanner.classList.remove('hidden');
    } else {
      resumeBanner.classList.add('hidden');
    }

    const grid = $('subjectGrid');
    grid.innerHTML = '';
    INDEX.subjects.forEach((name, idx) => {
      const sNum = idx + 1;
      const total = Number(INDEX.subjectCounts?.[String(sNum)] || 1220);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'subject-btn';
      btn.innerHTML = `
        <div class="subject-num">${sNum}과목</div>
        <div class="subject-name">${name}</div>
        <div class="subject-meta">기출 ${total.toLocaleString()}문제 중 ${subjectPickCount}문제 랜덤</div>
      `;
      btn.addEventListener('click', () => startSubjectQuiz(sNum, subjectPickCount));
      grid.appendChild(btn);
    });

    const sel = $('sessionSelect');
    if (sel.options.length === 0) {
      const rev = INDEX.sessions.slice().reverse();
      for (const s of rev) {
        const opt = document.createElement('option');
        opt.value = s.y;
        opt.textContent = `${formatYmd(s.y)} (${s.t.replace(/^토목기사 필기 기출문제 및 CBT\s*/, '')}) · ${s.n}문제`;
        sel.appendChild(opt);
      }
    }
    showScreen('home');
  }

  /* ---------------- Quiz Lifecycle ---------------- */
  function startQuiz({ title, mode, qIds, isReview = false, existingAnswers = null, cur = 0, elapsedSec = 0 }) {
    if (!qIds || qIds.length === 0) { alert('출제할 문제가 없습니다.'); return; }
    stopTimer();
    TTS.stop();
    const timeLimitSec = Math.round(qIds.length * 90);
    activeQuiz = { title, mode, isReview, qIds, answers: existingAnswers ? { ...existingAnswers } : {}, cur, startedAt: Date.now(), elapsedSec, timeLimitSec };
    persistSession();

    const isExam = mode === 'exam' && !isReview;
    $('quizTimer').classList.toggle('hidden', !isExam);
    $('quizLiveScore').classList.toggle('hidden', isExam);
    $('autoNextWrap').classList.toggle('hidden', isExam || isReview);
    $('autoReadWrap').classList.toggle('hidden', isExam);

    if (isExam) {
      updateTimerDisplay();
      timerHandle = setInterval(() => {
        activeQuiz.elapsedSec += 1;
        updateTimerDisplay();
        if (activeQuiz.elapsedSec >= activeQuiz.timeLimitSec) {
          stopTimer();
          alert('시험 시간이 종료되어 자동 채점합니다.');
          finishQuiz();
        }
      }, 1000);
    } else if (!isReview) {
      timerHandle = setInterval(() => { if (activeQuiz) activeQuiz.elapsedSec += 1; }, 1000);
    }

    showScreen('quiz');
    renderQuestion();
  }

  function updateTimerDisplay() {
    if (!activeQuiz) return;
    const remain = Math.max(0, activeQuiz.timeLimitSec - activeQuiz.elapsedSec);
    const el = $('quizTimer');
    el.textContent = `⏱ ${formatTime(remain)}`;
    el.classList.toggle('badge-red', remain <= 300);
    el.classList.toggle('badge-gray', remain > 300);
  }

  /* Fast 120-Question Random Exam: loads only 8 random sessions (~200KB gzipped) in parallel! */
  async function startRandom120() {
    showLoading('120문제 랜덤 모의고사 생성 중...');
    try {
      const recent = INDEX.sessions.filter((s) => Number(s.yr) >= 2023).map((s) => s.y);
      const older = shuffle(INDEX.sessions.filter((s) => Number(s.yr) < 2023).map((s) => s.y));
      // Mix 2 recent (2023~2026) + 6 older random sessions = 960 candidate questions in ~30ms!
      const chosenSessions = [...shuffle(recent).slice(0, 2), ...older.slice(0, 6)];
      const poolAll = await ensureSessions(chosenSessions);
      const picked = [];
      for (let s = 1; s <= 6; s++) {
        const sPool = shuffle(poolAll.filter((q) => q.s === s));
        picked.push(...sPool.slice(0, 20).map((q) => q.i));
      }
      hideLoading();
      startQuiz({ title: '120문제 랜덤 모의고사', mode: selectedMode, qIds: picked });
    } catch (err) {
      hideLoading();
      alert('문제를 불러오는 중 오류가 발생했습니다: ' + err.message);
    }
  }

  async function startSubjectQuiz(subjNum, count) {
    showLoading(`${subjNum}과목 문제 불러오는 중...`);
    try {
      const pool = await ensureSubject(subjNum);
      const picked = shuffle(pool).slice(0, Math.min(count, pool.length)).map((q) => q.i);
      hideLoading();
      startQuiz({ title: `${subjNum}과목 ${INDEX.subjects[subjNum - 1]} (${picked.length}문제)`, mode: selectedMode, qIds: picked });
    } catch (err) {
      hideLoading();
      alert('과목 문제를 불러오는 중 오류가 발생했습니다: ' + err.message);
    }
  }

  async function startSessionQuiz(ymd, startIdx = 0, autoReveal = false) {
    showLoading('기출 회차 불러오는 중...');
    try {
      const qs = await ensureSession(ymd);
      const meta = INDEX.sessions.find((s) => s.y === ymd);
      hideLoading();
      startQuiz({
        title: meta ? meta.t : `${formatYmd(ymd)} 기출문제`,
        mode: selectedMode,
        qIds: qs.map((q) => q.i),
        cur: Math.min(startIdx, Math.max(0, qs.length - 1)),
        isReview: autoReveal
      });
    } catch (err) {
      hideLoading();
      alert('회차 문제를 불러오는 중 오류가 발생했습니다: ' + err.message);
    }
  }

  async function startKeywordQuiz(keyword) {
    const kw = (keyword || '').trim().toLowerCase();
    if (!kw) { alert('검색할 키워드를 입력해 주세요. (예: 푸아송비, 베르누이, 압밀)'); return; }
    showLoading(`"${keyword}" 문제 검색 중...`);
    try {
      const idx = await ensureSearchIndex();
      const matchedIds = [];
      for (const [id, text] of idx) {
        if (text.toLowerCase().includes(kw)) matchedIds.push(id);
      }
      if (matchedIds.length === 0) {
        hideLoading();
        alert(`"${keyword}"와 관련된 기출문제를 찾지 못했습니다. 다른 단어로 검색해 보세요!`);
        return;
      }
      const pickedRaw = shuffle(matchedIds).slice(0, 40);
      const validIds = await ensureQuestionsByIds(pickedRaw);
      hideLoading();
      startQuiz({ title: `"${keyword}" 집중 풀이 (${validIds.length} / 총 ${matchedIds.length}문제)`, mode: 'practice', qIds: validIds });
    } catch (err) {
      hideLoading();
      alert('검색 중 오류가 발생했습니다: ' + err.message);
    }
  }

  async function startWrongNoteQuiz() {
    if (wrongIds.size === 0) { alert('오답노트가 비어 있습니다! 문제를 풀면서 틀린 문제가 자동으로 저장됩니다.'); return; }
    showLoading('오답노트 불러오는 중...');
    try {
      const valid = await ensureQuestionsByIds(shuffle(Array.from(wrongIds)));
      hideLoading();
      startQuiz({ title: `오답노트 복습 (${valid.length}문제)`, mode: 'practice', qIds: valid });
    } catch (err) {
      hideLoading();
      alert('오답노트 로드 오류: ' + err.message);
    }
  }

  async function startBookmarkQuiz() {
    if (bookmarkIds.size === 0) { alert('북마크한 문제가 없습니다. 풀이 중 상단 ☆ 버튼을 눌러 저장해 보세요.'); return; }
    showLoading('북마크 문제 불러오는 중...');
    try {
      const valid = await ensureQuestionsByIds(Array.from(bookmarkIds));
      hideLoading();
      startQuiz({ title: `별표 북마크 복습 (${valid.length}문제)`, mode: 'practice', qIds: valid });
    } catch (err) {
      hideLoading();
      alert('북마크 로드 오류: ' + err.message);
    }
  }

  /* ---------------- Render Explanation (Easy vs Original Tab) ---------------- */
  function renderExplanationContent(q) {
    const expEl = $('feedbackExp');
    const tabEasy = $('tabEasyExp');
    const tabOrig = $('tabOrigExp');
    tabEasy.classList.toggle('active', activeExpTab === 'easy');
    tabEasy.setAttribute('aria-selected', String(activeExpTab === 'easy'));
    tabOrig.classList.toggle('active', activeExpTab === 'orig');
    tabOrig.setAttribute('aria-selected', String(activeExpTab === 'orig'));

    activeEasyData = EASY.build(q, INDEX.subjects[q.s - 1]);
    if (activeExpTab === 'easy') {
      expEl.innerHTML = sanitizeHtml(activeEasyData.html);
      // Quietly prefetch opening sentence in background so clicking "음성으로 듣기" starts instantly!
      if (typeof TTS.prefetch === 'function') TTS.prefetch(activeEasyData.speechSegments);
    } else {
      expEl.innerHTML = `<div class="orig-exp-wrap" data-tts-seg="orig-exp">${q.e ? sanitizeHtml(q.e) : '<span style="color:var(--text-light)">등록된 해설이 없습니다.</span>'}</div>`;
    }
    enhanceImages(expEl, false);
    renderMath(expEl);
  }

  function setExpTab(tab) {
    if (tab !== 'easy' && tab !== 'orig') return;
    activeExpTab = tab;
    try { localStorage.setItem(STORAGE_KEYS.expTab, tab); } catch {}
    TTS.stop();
    if (activeQuiz) {
      const q = byId.get(activeQuiz.qIds[activeQuiz.cur]);
      if (q) renderExplanationContent(q);
    }
  }

  $('tabEasyExp').addEventListener('click', () => setExpTab('easy'));
  $('tabOrigExp').addEventListener('click', () => setExpTab('orig'));

  function updateQuizStatsUI() {
    if (!activeQuiz) return;
    const total = activeQuiz.qIds.length;
    const answeredCount = Object.keys(activeQuiz.answers).length;
    $('btnOpenOmr').textContent = `📋 OMR (${answeredCount}/${total})`;
    if (activeQuiz.mode === 'practice' || activeQuiz.isReview) {
      let ok = 0, bad = 0;
      for (const [k, val] of Object.entries(activeQuiz.answers)) {
        const qq = byId.get(activeQuiz.qIds[Number(k)]);
        if (qq) { if (val === qq.a) ok++; else bad++; }
      }
      $('quizLiveScore').textContent = `정답 ${ok} · 오답 ${bad}`;
    }
  }

  function renderFeedbackBox(q, chosen) {
    const fb = $('feedbackBox');
    const isRight = chosen === q.a;
    fb.classList.remove('hidden', 'ok', 'bad');
    fb.classList.add(isRight ? 'ok' : 'bad');
    if (chosen === undefined) $('feedbackHeadline').textContent = `정답은 ${CIRCLED[q.a]}번입니다.`;
    else if (isRight) $('feedbackHeadline').textContent = `⭕ 정답입니다! (${CIRCLED[q.a]})`;
    else $('feedbackHeadline').textContent = `❌ 오답입니다. 내 선택 ${CIRCLED[chosen]} / 정답 ${CIRCLED[q.a]}`;

    renderExplanationContent(q);
    $('btnRemoveWrong').classList.toggle('hidden', !(isRight && wrongIds.has(q.i)));
  }

  /* ---------------- Render Question ---------------- */
  function renderQuestion() {
    if (!activeQuiz) return;
    if (autoNextTimeout) { clearTimeout(autoNextTimeout); autoNextTimeout = null; }
    TTS.stop();

    const idx = activeQuiz.cur;
    const total = activeQuiz.qIds.length;
    const q = byId.get(activeQuiz.qIds[idx]);
    if (!q) return;
    const chosen = activeQuiz.answers[idx];
    const showImmediate = activeQuiz.isReview || (activeQuiz.mode === 'practice' && chosen !== undefined);

    $('quizModeBadge').textContent = activeQuiz.isReview ? '해설 보기' : activeQuiz.mode === 'exam' ? '실전 모드' : '연습 모드';
    $('quizProgressText').textContent = `${idx + 1} / ${total}`;
    $('quizProgressFill').style.width = `${Math.round(((idx + 1) / total) * 100)}%`;
    updateQuizStatsUI();

    const isBm = bookmarkIds.has(q.i);
    const btnBm = $('btnBookmark');
    btnBm.textContent = isBm ? '★' : '☆';
    btnBm.classList.toggle('active', isBm);

    $('btnFinishEarly').textContent = activeQuiz.isReview ? '결과표' : '채점';
    $('qSubjectBadge').textContent = `${q.s}과목 · ${INDEX.subjects[q.s - 1]}`;
    $('qSourceBadge').textContent = `${formatYmd(q.y)} 기출 #${q.n}${q.r ? ' · 정답률 ' + q.r : ''}`;

    const stemEl = $('qStem');
    stemEl.innerHTML = `<span class="q-num-inline">${idx + 1}.</span>${sanitizeHtml(q.q)}`;
    enhanceImages(stemEl, true);
    renderMath(stemEl);

    const list = $('choicesList');
    list.innerHTML = '';
    q.c.forEach((cHtml, cIdx) => {
      const choiceNum = cIdx + 1;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-btn';
      btn.dataset.choice = String(choiceNum);

      let tagHtml = '';
      if (showImmediate) {
        if (choiceNum === q.a) { btn.classList.add('correct'); tagHtml = '<span class="choice-tag">✓ 정답</span>'; }
        else if (chosen === choiceNum) { btn.classList.add('wrong'); tagHtml = '<span class="choice-tag">✗ 내 답</span>'; }
        if (activeQuiz.isReview) btn.disabled = true;
      } else if (chosen === choiceNum) {
        btn.classList.add('selected');
      }

      btn.innerHTML = `<span class="choice-circle">${CIRCLED[choiceNum]}</span><span class="choice-content">${sanitizeHtml(cHtml)}</span>${tagHtml}`;
      btn.addEventListener('click', () => handleChoose(choiceNum));
      list.appendChild(btn);
    });
    enhanceImages(list, false);
    renderMath(list);

    if (showImmediate) {
      renderFeedbackBox(q, chosen);
    } else {
      activeEasyData = null;
      $('feedbackBox').classList.add('hidden');
    }

    $('btnPrev').disabled = idx === 0;
    $('btnNext').textContent = idx === total - 1 ? (activeQuiz.isReview ? '결과표 보기' : '최종 채점 ✓') : '다음 →';
  }

  /* Instant In-Place Choice Reveal (< 5ms, zero image/stem flicker!) */
  function handleChoose(choiceNum) {
    if (!activeQuiz || activeQuiz.isReview) return;
    const idx = activeQuiz.cur;
    const q = byId.get(activeQuiz.qIds[idx]);
    if (!q) return;
    if (activeQuiz.mode === 'practice' && activeQuiz.answers[idx] !== undefined) return;

    activeQuiz.answers[idx] = choiceNum;
    if (activeQuiz.mode === 'practice' && choiceNum !== q.a) {
      wrongIds.add(q.i);
      saveSet(STORAGE_KEYS.wrong, wrongIds);
    }

    persistSession();
    updateQuizStatsUI();

    // Update existing 4 choice buttons IN PLACE without touching stem/images/KaTeX!
    const buttons = $('choicesList').querySelectorAll('.choice-btn');
    buttons.forEach((btn) => {
      const cNum = Number(btn.dataset.choice);
      btn.classList.remove('selected', 'correct', 'wrong');
      const oldTag = btn.querySelector('.choice-tag');
      if (oldTag) oldTag.remove();

      if (activeQuiz.mode === 'practice') {
        if (cNum === q.a) {
          btn.classList.add('correct');
          btn.insertAdjacentHTML('beforeend', '<span class="choice-tag">✓ 정답</span>');
        } else if (cNum === choiceNum) {
          btn.classList.add('wrong');
          btn.insertAdjacentHTML('beforeend', '<span class="choice-tag">✗ 내 답</span>');
        }
      } else if (cNum === choiceNum) {
        btn.classList.add('selected');
      }
    });

    if (activeQuiz.mode === 'practice') {
      renderFeedbackBox(q, choiceNum);
      if (TTS.getAutoRead()) {
        playCurrentExplanation();
      }
      if (choiceNum === q.a && chkAutoNext.checked && !TTS.getAutoRead() && idx < activeQuiz.qIds.length - 1) {
        autoNextTimeout = setTimeout(() => {
          if (activeQuiz && activeQuiz.cur === idx) {
            activeQuiz.cur += 1;
            persistSession();
            renderQuestion();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
        }, 650);
      }
    }
  }

  /* ---------------- Finish & Result Screen ---------------- */
  function finishQuiz() {
    if (!activeQuiz) return;
    stopTimer();
    TTS.stop();

    const total = activeQuiz.qIds.length;
    const subjStats = {};
    let totalCorrect = 0;
    const wrongInRun = [];

    for (let i = 0; i < total; i++) {
      const q = byId.get(activeQuiz.qIds[i]);
      if (!q) continue;
      if (!subjStats[q.s]) subjStats[q.s] = { correct: 0, total: 0 };
      subjStats[q.s].total += 1;
      const chosen = activeQuiz.answers[i];
      if (chosen === q.a) { totalCorrect += 1; subjStats[q.s].correct += 1; }
      else { wrongInRun.push(q.i); if (chosen !== undefined) wrongIds.add(q.i); }
    }
    saveSet(STORAGE_KEYS.wrong, wrongIds);
    clearSavedSession();

    const avgScore = Math.round((totalCorrect / total) * 1000) / 10;
    const subjectKeys = Object.keys(subjStats).map(Number).sort((a, b) => a - b);
    const isFullExam = subjectKeys.length === 6 && total >= 120;
    const hasFailSubject = subjectKeys.some((s) => (subjStats[s].correct / subjStats[s].total) * 100 < 40);
    const passed = avgScore >= 60 && !hasFailSubject;

    const hero = $('resultHero');
    hero.classList.remove('pass', 'fail', 'neutral');
    if (isFullExam) {
      hero.classList.add(passed ? 'pass' : 'fail');
      $('resultModeLabel').textContent = `${activeQuiz.title} · ${passed ? '🎉 합격 기준 충족!' : '아쉽지만 불합격'}`;
    } else {
      hero.classList.add(avgScore >= 60 ? 'pass' : 'neutral');
      $('resultModeLabel').textContent = `${activeQuiz.title} 채점 결과`;
    }

    $('resultScoreBig').textContent = `${avgScore.toFixed(1)}점`;
    $('resultSummaryText').textContent = `정답 ${totalCorrect} / ${total}문항 · 소요 시간 ${formatTime(activeQuiz.elapsedSec)}${hasFailSubject && isFullExam ? ' · 과락 과목 발생' : ''}`;

    const list = $('subjectResultsList');
    list.innerHTML = '';
    for (const s of subjectKeys) {
      const st = subjStats[s];
      const sc = Math.round((st.correct / st.total) * 100);
      const isFail = sc < 40;
      const row = document.createElement('div');
      row.className = 'subj-result-row';
      row.innerHTML = `
        <div class="subj-result-head">
          <span>${s}과목 · ${INDEX.subjects[s - 1]}</span>
          <span>${sc}점 (${st.correct}/${st.total}) ${isFail ? '<strong style="color:var(--bad)">[과락]</strong>' : ''}</span>
        </div>
        <div class="bar-bg"><div class="bar-val ${isFail ? 'fail' : ''}" style="width:${sc}%"></div></div>
      `;
      list.appendChild(row);
    }

    const btnRetry = $('btnRetryWrong');
    btnRetry.disabled = wrongInRun.length === 0;
    btnRetry.textContent = wrongInRun.length > 0 ? `❌ 틀린 ${wrongInRun.length}문제만 다시 풀기` : '🎉 만점! 틀린 문제 없음';
    btnRetry.onclick = () => {
      if (wrongInRun.length > 0) startQuiz({ title: `방금 틀린 문제 복습 (${wrongInRun.length}문제)`, mode: 'practice', qIds: wrongInRun });
    };
    showScreen('result');
  }

  /* ---------------- OMR Modal ---------------- */
  function openOmr() {
    if (!activeQuiz) return;
    const total = activeQuiz.qIds.length;
    const answeredCount = Object.keys(activeQuiz.answers).length;
    $('omrTitle').textContent = `📋 OMR 답안지 (${answeredCount} / ${total} 풀이)`;

    const body = $('omrBody');
    body.innerHTML = '';
    const groups = [];
    for (let i = 0; i < total; i++) {
      const q = byId.get(activeQuiz.qIds[i]);
      if (!q) continue;
      if (groups.length === 0 || groups[groups.length - 1].s !== q.s) groups.push({ s: q.s, items: [] });
      groups[groups.length - 1].items.push({ idx: i, q });
    }

    for (const g of groups) {
      const h = document.createElement('div');
      h.className = 'omr-subj-title';
      h.textContent = `${g.s}과목 · ${INDEX.subjects[g.s - 1]}`;
      body.appendChild(h);

      const grid = document.createElement('div');
      grid.className = 'omr-grid';
      for (const item of g.items) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'omr-cell';
        if (item.idx === activeQuiz.cur) cell.classList.add('current');
        const chosen = activeQuiz.answers[item.idx];
        if (chosen !== undefined) {
          if (activeQuiz.mode === 'practice' || activeQuiz.isReview) cell.classList.add(chosen === item.q.a ? 'ok' : 'bad');
          else cell.classList.add('answered');
          cell.textContent = `${item.idx + 1} ${CIRCLED[chosen]}`;
        } else {
          cell.textContent = `${item.idx + 1}`;
        }
        cell.addEventListener('click', () => {
          activeQuiz.cur = item.idx;
          persistSession();
          closeOmr();
          renderQuestion();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        grid.appendChild(cell);
      }
      body.appendChild(grid);
    }
    $('btnSubmitFromOmr').classList.toggle('hidden', activeQuiz.isReview);
    $('omrModal').classList.remove('hidden');
  }
  function closeOmr() { $('omrModal').classList.add('hidden'); }

  /* ---------------- Glossary Modal ---------------- */
  function renderGlossary() {
    const body = $('glossaryBody');
    const q = ($('glossarySearch').value || '').trim().toLowerCase();
    const list = (CONCEPTS?.CONCEPTS || []).filter((c) => {
      if (glossarySubjectFilter !== 0 && c.s !== glossarySubjectFilter) return false;
      if (!q) return true;
      return (`${c.title} ${c.analogy} ${c.rule} ${c.tip} ${c.kw.join(' ')}`).toLowerCase().includes(q);
    });

    if (list.length === 0) {
      body.innerHTML = `<p style="text-align:center;color:var(--text-light);padding:24px 0;">검색 결과가 없습니다. 다른 단어로 찾아보세요!</p>`;
      return;
    }

    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'glossary-list';
    for (const c of list) {
      const card = document.createElement('div');
      card.className = 'glossary-card';
      card.innerHTML = `
        <div class="glossary-card-top">
          <div>
            <span class="badge badge-blue" style="margin-bottom:4px;">${c.s}과목 · ${INDEX.subjects[c.s - 1]}</span>
            <div class="glossary-card-title">${c.emoji || '💡'} ${c.title}</div>
          </div>
          <button type="button" class="tts-mini-btn">🔊 듣기</button>
        </div>
        <p class="glossary-card-p">${c.analogy}</p>
        <p class="glossary-card-p"><strong>핵심 규칙:</strong> ${c.rule}</p>
        <p class="glossary-card-tip">✨ ${c.tip}</p>
      `;
      card.querySelector('.tts-mini-btn').addEventListener('click', () => {
        TTS.speakSegments([
          { id: 'gloss-1', text: `${c.title}. ${c.analogy} ${c.tip}` }
        ], 'glossary');
      });
      wrap.appendChild(card);
    }
    body.appendChild(wrap);
  }

  function openGlossary() { renderGlossary(); $('glossaryModal').classList.remove('hidden'); }
  function closeGlossary() { TTS.stop(); $('glossaryModal').classList.add('hidden'); }

  $('btnOpenGlossary').addEventListener('click', openGlossary);
  $('btnCloseGlossary').addEventListener('click', closeGlossary);
  $('glossaryModal').addEventListener('click', (e) => { if (e.target === $('glossaryModal')) closeGlossary(); });
  $('glossarySearch').addEventListener('input', renderGlossary);
  $('glossarySubjTabs').querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('glossarySubjTabs').querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      glossarySubjectFilter = Number(chip.dataset.s);
      renderGlossary();
    });
  });

  /* ---------------- Voice Settings Modal ---------------- */
  function populateVoiceSelect(passedVoices) {
    const sel = $('voiceSelect');
    const vList = Array.isArray(passedVoices) ? passedVoices : TTS.getVoices();
    const active = TTS.getActiveVoice();
    sel.innerHTML = '';
    if (!vList.length) {
      const opt = document.createElement('option');
      opt.value = 'F5';
      opt.textContent = '다정한 선생님 (F5 · 부드럽고 따뜻한 여성)';
      sel.appendChild(opt);
      return;
    }
    for (const v of vList) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.isNeural ? `🎀 ${v.name}` : v.name;
      if (active && active.id === v.id) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  TTS.onVoicesReady((vList) => populateVoiceSelect(vList));

  function openVoiceModal() {
    populateVoiceSelect();
    syncSpeedButtons(TTS.getRate());
    syncAutoReadUI(TTS.getAutoRead());
    $('voiceModal').classList.remove('hidden');
  }
  function closeVoiceModal() { $('voiceModal').classList.add('hidden'); }

  $('btnOpenVoiceSettings').addEventListener('click', openVoiceModal);
  $('btnCloseVoice').addEventListener('click', closeVoiceModal);
  $('voiceModal').addEventListener('click', (e) => { if (e.target === $('voiceModal')) closeVoiceModal(); });
  $('voiceSelect').addEventListener('change', () => TTS.setVoiceByName($('voiceSelect').value));
  $('btnTestVoice').addEventListener('click', () => {
    TTS.speakSegments([
      { id: 'test-1', text: '안녕하세요! 토목기사 쉬운 풀이 음성 선생님이에요. 고무줄을 당기면 옆이 홀쭉해지는 비율이 바로 푸아송비랍니다.' }
    ], 'glossary');
  });
  $('btnStopTestVoice').addEventListener('click', () => TTS.stop());

  /* ---------------- Event Wiring ---------------- */
  document.querySelectorAll('.mode-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMode = btn.dataset.mode;
    });
  });

  $('subjectCountChips').querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('subjectCountChips').querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      subjectPickCount = Number(chip.dataset.count);
      renderHome();
    });
  });

  $('btnStartRandom120').addEventListener('click', startRandom120);
  $('btnStartSession').addEventListener('click', () => startSessionQuiz($('sessionSelect').value));
  $('cardWrongNote').addEventListener('click', startWrongNoteQuiz);
  $('cardBookmarks').addEventListener('click', startBookmarkQuiz);

  $('btnKeywordSearch').addEventListener('click', () => startKeywordQuiz($('keywordSearchInput').value));
  $('keywordSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startKeywordQuiz($('keywordSearchInput').value);
  });
  $('quickSearchTags').querySelectorAll('.tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('keywordSearchInput').value = chip.dataset.kw;
      startKeywordQuiz(chip.dataset.kw);
    });
  });

  $('btnResume').addEventListener('click', async () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.session) || 'null');
      if (saved && Array.isArray(saved.qIds)) {
        showLoading('진행 중이던 모의고사 복원 중...');
        const validIds = await ensureQuestionsByIds(saved.qIds);
        hideLoading();
        startQuiz({ title: saved.title, mode: saved.mode, qIds: validIds, existingAnswers: saved.answers || {}, cur: Math.min(saved.cur || 0, Math.max(0, validIds.length - 1)), elapsedSec: saved.elapsedSec || 0 });
      }
    } catch { hideLoading(); }
  });
  $('btnDiscardResume').addEventListener('click', () => { clearSavedSession(); renderHome(); });

  $('btnHomeLogo').addEventListener('click', () => {
    TTS.stop();
    if (!screenQuiz.classList.contains('hidden') && activeQuiz && !activeQuiz.isReview) persistSession();
    renderHome();
  });

  $('btnBookmark').addEventListener('click', () => {
    if (!activeQuiz) return;
    const qId = activeQuiz.qIds[activeQuiz.cur];
    if (bookmarkIds.has(qId)) bookmarkIds.delete(qId); else bookmarkIds.add(qId);
    saveSet(STORAGE_KEYS.bookmarks, bookmarkIds);
    const isBm = bookmarkIds.has(qId);
    $('btnBookmark').textContent = isBm ? '★' : '☆';
    $('btnBookmark').classList.toggle('active', isBm);
  });

  $('btnRemoveWrong').addEventListener('click', () => {
    if (!activeQuiz) return;
    const qId = activeQuiz.qIds[activeQuiz.cur];
    wrongIds.delete(qId);
    saveSet(STORAGE_KEYS.wrong, wrongIds);
    $('btnRemoveWrong').classList.add('hidden');
  });

  $('btnPrev').addEventListener('click', () => {
    if (!activeQuiz || activeQuiz.cur <= 0) return;
    activeQuiz.cur -= 1;
    persistSession();
    renderQuestion();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('btnNext').addEventListener('click', () => {
    if (!activeQuiz) return;
    if (activeQuiz.cur < activeQuiz.qIds.length - 1) {
      activeQuiz.cur += 1;
      persistSession();
      renderQuestion();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (activeQuiz.isReview) showScreen('result');
    else confirmAndFinish();
  });

  function confirmAndFinish() {
    if (!activeQuiz) return;
    if (activeQuiz.isReview) { showScreen('result'); return; }
    const answered = Object.keys(activeQuiz.answers).length;
    const total = activeQuiz.qIds.length;
    if (answered < total && !confirm(`아직 ${total - answered}문항을 풀지 않았습니다.\n지금 채점하시겠습니까?`)) return;
    closeOmr();
    finishQuiz();
  }

  $('btnFinishEarly').addEventListener('click', confirmAndFinish);
  $('btnOpenOmr').addEventListener('click', openOmr);
  $('btnCloseOmr').addEventListener('click', closeOmr);
  $('omrModal').addEventListener('click', (e) => { if (e.target === $('omrModal')) closeOmr(); });
  $('btnSubmitFromOmr').addEventListener('click', confirmAndFinish);
  $('btnJumpUnanswered').addEventListener('click', () => {
    if (!activeQuiz) return;
    const idx = activeQuiz.qIds.findIndex((_, i) => activeQuiz.answers[i] === undefined);
    if (idx === -1) { alert('모든 문항에 답을 선택했습니다!'); return; }
    activeQuiz.cur = idx;
    persistSession();
    closeOmr();
    renderQuestion();
  });

  $('btnReviewAll').addEventListener('click', () => {
    if (!activeQuiz) return;
    activeQuiz.isReview = true;
    activeQuiz.cur = 0;
    $('quizTimer').classList.add('hidden');
    $('quizLiveScore').classList.remove('hidden');
    $('autoNextWrap').classList.add('hidden');
    $('autoReadWrap').classList.remove('hidden');
    showScreen('quiz');
    renderQuestion();
  });

  $('btnNewRandom120').addEventListener('click', startRandom120);
  $('btnBackHomeResult').addEventListener('click', renderHome);

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    if (!$('zoomModal').classList.contains('hidden')) { if (e.key === 'Escape') $('zoomModal').classList.add('hidden'); return; }
    if (!$('glossaryModal').classList.contains('hidden')) { if (e.key === 'Escape') closeGlossary(); return; }
    if (!$('voiceModal').classList.contains('hidden')) { if (e.key === 'Escape') closeVoiceModal(); return; }
    if (screenQuiz.classList.contains('hidden')) return;
    if (!$('omrModal').classList.contains('hidden')) { if (e.key === 'Escape') closeOmr(); return; }

    if (['1', '2', '3', '4'].includes(e.key)) handleChoose(Number(e.key));
    else if (e.key === 'ArrowLeft') $('btnPrev').click();
    else if (e.key === 'ArrowRight') $('btnNext').click();
    else if (e.key.toLowerCase() === 'o') openOmr();
    else if (e.key.toLowerCase() === 's') {
      if (!$('feedbackBox').classList.contains('hidden')) playCurrentExplanation();
    } else if (e.key.toLowerCase() === 't') {
      if (!$('feedbackBox').classList.contains('hidden')) setExpTab(activeExpTab === 'easy' ? 'orig' : 'easy');
    } else if (e.key === 'Escape') {
      TTS.stop();
    }
  });

  window.addEventListener('beforeunload', () => TTS.stop());

  /* ---------------- Deep-Link Initialization ---------------- */
  const params = new URLSearchParams(location.search);
  const pSession = params.get('session');
  if (pSession && validSessionSet.has(pSession)) {
    const qIdx = Math.max(0, (Number(params.get('q')) || 1) - 1);
    const reveal = params.get('reveal') === '1';
    renderHome();
    startSessionQuiz(pSession, qIdx, reveal);
  } else {
    renderHome();
  }
})();
