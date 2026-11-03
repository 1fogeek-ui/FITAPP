(() => {
  'use strict';

  const REST_TARGET = 90; // secondes (1 min 30)
  const STORAGE_KEY = 'tempo-session-v2';
  const CIRC = 2 * Math.PI * 138;

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('status'), dial: $('dial'), progress: $('progress'), time: $('time'),
    hint: $('hint'), notice: $('notice'),
    start: $('start'), exercise: $('exercise'), rest: $('rest'),
    pause: $('pause'), finish: $('finish'),
    exTotal: $('exTotal'), restTotal: $('restTotal'), total: $('total'),
    sets: $('sets'), install: $('install'),
    summary: $('summary'), summaryList: $('summaryList'), summaryText: $('summaryText'),
    reset: $('reset'), timerSection: document.querySelector('.timer'),
  };

  el.progress.style.strokeDasharray = CIRC;

  const fresh = () => ({
    sessionStart: null,   // début de présence (ms)
    mode: null,           // null | 'exercise' | 'rest'
    totals: { exercise: 0, rest: 0 }, // temps cumulés des modes terminés (ms)
    curAccum: 0,          // temps accumulé du mode en cours avant la dernière reprise (ms)
    segStart: null,       // début du segment en cours (ms), null si pause ou aucun mode
    paused: false,
    sets: 0,
    alerted: false,
  });

  let s = fresh();
  let audioCtx = null;
  let wakeLock = null;
  let ticker = null;

  /* ---------- Persistance (reprise après rechargement) ---------- */
  const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {} };
  const clearSave = () => { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} };
  const load = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) { const o = JSON.parse(raw); if (o && o.sessionStart) s = Object.assign(fresh(), o); }
    } catch (e) {}
  };

  /* ---------- Utilitaires ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };
  const fmtLong = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    if (h > 0) return `${h} h ${pad(m)} min ${pad(sec)} s`;
    if (m > 0) return `${m} min ${pad(sec)} s`;
    return `${sec} s`;
  };

  const sessionActive = () => s.sessionStart !== null;
  const currentMs = (now) => s.curAccum + (s.segStart ? now - s.segStart : 0);

  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      [0, 0.22, 0.44].forEach((d) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        o.connect(g); g.connect(audioCtx.destination);
        const t0 = audioCtx.currentTime + d;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.start(t0); o.stop(t0 + 0.2);
      });
    } catch (e) {}
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  async function lockScreen() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function unlockScreen() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sessionActive() && !wakeLock) lockScreen();
  });

  /* ---------- Logique ---------- */
  function startSession(now) {
    if (sessionActive()) return;
    s = fresh();
    s.sessionStart = now;
    lockScreen();
    startTicker();
  }

  // Termine le mode en cours : son temps est ajouté à son cumul. La présence n'est jamais touchée.
  function closeMode(now) {
    if (s.mode) s.totals[s.mode] += currentMs(now);
    s.mode = null; s.curAccum = 0; s.segStart = null; s.paused = false;
  }

  function switchMode(next) {
    const now = Date.now();
    if (!sessionActive()) startSession(now);
    if (s.mode === next) {
      if (s.paused) togglePause(); // re-cliquer sur le mode en pause le reprend
      return;
    }
    closeMode(now);
    s.mode = next;
    s.segStart = now;
    s.alerted = false;
    if (next === 'exercise') s.sets += 1;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    else if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    save(); render();
  }

  function togglePause() {
    if (!sessionActive() || !s.mode) return;
    const now = Date.now();
    if (s.paused) { s.segStart = now; s.paused = false; }
    else { s.curAccum += now - s.segStart; s.segStart = null; s.paused = true; }
    save(); render();
  }

  function finishSession() {
    if (!sessionActive()) return;
    const now = Date.now();
    closeMode(now);
    const presence = now - s.sessionStart;
    const ex = s.totals.exercise, rest = s.totals.rest;
    const other = Math.max(0, presence - ex - rest);
    const sets = s.sets;
    stopTicker(); unlockScreen(); clearSave();
    s = fresh();
    showSummary({ presence, ex, rest, other, sets });
    render();
  }

  function showSummary({ presence, ex, rest, other, sets }) {
    const rows = [
      ['Temps total de présence', presence, 'Du début à la fin de la séance'],
      ['Temps total d’exercice', ex, `${sets} série${sets > 1 ? 's' : ''}`],
      ['Temps total de repos', rest, 'Entre les séries'],
      ['Temps non comptabilisé', other, 'Transitions et autres moments'],
    ];
    el.summaryList.innerHTML = '';
    rows.forEach(([label, ms, note]) => {
      const row = document.createElement('div');
      row.className = 'summary-row';
      const l = document.createElement('span'); l.textContent = label;
      const v = document.createElement('strong'); v.textContent = fmtLong(ms);
      const n = document.createElement('small'); n.textContent = note;
      row.append(l, v, n);
      el.summaryList.appendChild(row);
    });
    el.summaryText.textContent = `Présence = exercice + repos + non comptabilisé : ${fmt(presence)} = ${fmt(ex)} + ${fmt(rest)} + ${fmt(other)}.`;
    el.timerSection.hidden = true;
    el.summary.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetAll() {
    stopTicker(); unlockScreen(); clearSave();
    s = fresh();
    el.summary.hidden = true;
    el.timerSection.hidden = false;
    render();
  }

  /* ---------- Affichage ---------- */
  function render() {
    const now = Date.now();
    const active = sessionActive();
    const cur = currentMs(now);
    const ex = s.totals.exercise + (s.mode === 'exercise' ? cur : 0);
    const rest = s.totals.rest + (s.mode === 'rest' ? cur : 0);
    const presence = active ? now - s.sessionStart : 0;

    el.exTotal.textContent = fmt(ex);
    el.restTotal.textContent = fmt(rest);
    el.total.textContent = fmt(presence);
    el.sets.textContent = `${s.sets} série${s.sets > 1 ? 's' : ''}`;

    // Compteur du mode en cours
    el.time.textContent = s.mode ? fmt(cur) : '00:00';

    let ratio = 0;
    if (s.mode === 'rest') ratio = Math.min(cur / (REST_TARGET * 1000), 1);
    else if (s.mode === 'exercise') ratio = (cur % 60000) / 60000;
    el.progress.style.strokeDashoffset = String(CIRC * (1 - ratio));

    el.dial.dataset.mode = s.mode || 'idle';
    el.dial.classList.toggle('paused', s.paused);
    el.exercise.classList.toggle('active', s.mode === 'exercise');
    el.rest.classList.toggle('active', s.mode === 'rest');
    el.exercise.setAttribute('aria-pressed', String(s.mode === 'exercise'));
    el.rest.setAttribute('aria-pressed', String(s.mode === 'rest'));

    // Textes
    if (!active) {
      el.status.textContent = 'PRÊT POUR VOTRE SÉANCE';
      el.hint.textContent = 'Lancez votre séance';
      el.notice.textContent = 'À votre rythme. Une série à la fois.';
    } else if (!s.mode) {
      el.status.textContent = 'SÉANCE EN COURS';
      el.hint.textContent = 'Choisissez Exercice ou Repos';
      el.notice.textContent = 'Le temps de présence tourne. Aucun compteur actif.';
    } else if (s.paused) {
      el.status.textContent = `${s.mode === 'exercise' ? 'EXERCICE' : 'REPOS'} · EN PAUSE`;
      el.hint.textContent = 'Compteur en pause';
      el.notice.textContent = 'Le temps de présence continue de tourner.';
    } else if (s.mode === 'exercise') {
      el.status.textContent = `EXERCICE EN COURS · SÉRIE ${s.sets}`;
      el.hint.textContent = 'Donnez tout';
      el.notice.textContent = 'Concentrez-vous sur la série.';
    } else {
      el.status.textContent = 'REPOS EN COURS';
      const left = REST_TARGET * 1000 - cur;
      if (left > 0) {
        el.hint.textContent = `Reprise dans ${fmt(left)}`;
        el.notice.textContent = 'Récupérez, respirez.';
      } else {
        el.hint.textContent = 'Repos cible atteint';
        el.notice.textContent = 'Prêt pour la prochaine série.';
      }
    }

    // Alerte de fin de repos (une seule fois par repos)
    if (s.mode === 'rest' && !s.paused && !s.alerted && cur >= REST_TARGET * 1000) {
      s.alerted = true; save(); beep();
    }

    // Boutons
    el.start.hidden = active;
    el.pause.disabled = !active || !s.mode;
    el.pause.textContent = s.paused ? 'Reprendre' : 'Mettre en pause';
    el.finish.disabled = !active;
  }

  function startTicker() { if (!ticker) ticker = setInterval(render, 250); }
  function stopTicker() { clearInterval(ticker); ticker = null; }

  /* ---------- Événements ---------- */
  el.start.addEventListener('click', () => {
    startSession(Date.now()); save(); render();
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  });
  el.exercise.addEventListener('click', () => switchMode('exercise'));
  el.rest.addEventListener('click', () => switchMode('rest'));
  el.pause.addEventListener('click', togglePause);
  el.finish.addEventListener('click', finishSession);
  el.reset.addEventListener('click', resetAll);

  /* ---------- Installation PWA ---------- */
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e; el.install.hidden = false;
  });
  el.install.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null; el.install.hidden = true;
  });
  window.addEventListener('appinstalled', () => { el.install.hidden = true; });

  if ('serviceWorker' in navigator) {
    // Adaptez le nom si votre service worker s'appelle autrement
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  /* ---------- Démarrage ---------- */
  load();
  if (sessionActive()) { startTicker(); lockScreen(); }
  render();
})();
