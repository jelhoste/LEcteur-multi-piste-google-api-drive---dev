import { parseOggOpus, decodeRange } from './ogg-opus.js';
import { createDrive, createCache, loadSong, parseFolderId } from './drive.js';
import { buildMeta, snapBeat, snapBar, barBeatAt, prevBar, nextBar, chordAt, bpmAt, lyricAt, sectionsView, sectionAt, shortLabel, transposeChord, transposeKey, spellingFor, chordsInRange, barsInRange } from './meta.js';
import { kindOf, KIND_LABEL, iconSvg, pressable, tempoModel, loopTap, loopLong, sectionJump } from './ui-helpers.js';
import { createPool, delayOut } from './stretch.js';

const $ = id => document.getElementById(id);
const T = window.Themes;
const SR = 48000, BLOCK = 96000, AHEAD = 4;               // blocs de 2 s, 4 s planifiées d'avance
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const fmtT = s => { const d = Math.floor(Math.max(0, s) * 10), sec = (d % 600) / 10; return Math.floor(d / 600) + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1); };
const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
const msg = t => { $('msg').textContent = t || ''; };
const status = t => { $('status').textContent = t || ''; };
const pref = { notation: store.get('chordNotation') || 'pop', level: store.get('chordLevel') || 'simple' };
let curTab = store.get('tab') || 'mixer', shownTab = null;           // onglet préféré et onglet affiché
const solo = new Set();                                              // pistes en solo (cumulables)
let trFn = x => x, keyFlats = false;                                // transposition des accords à l'affichage (la notation Nashville, relative à la tonalité, ne change pas)

// ---------------- Lecteur ----------------
let ctx = null, tracks = [], gains = [], playing = false, gen = 0, pumping = false, timer = null;
let segs = [], live = new Set(), cursorSample = 0, cursorWhen = 0, posSample = 0, endWhen = 0, dragging = false;
const dur = () => Math.min(...tracks.map(t => t.p.durationSamples));
// Vitesse (time stretch, hauteur conservée) et transposition : réglages globaux, identiques pour toutes les pistes (sinon elles se décaleraient).
// À 100 % et 0 demi-ton, le chemin de lecture ci-dessous est strictement l'ancien (aucun calcul ajouté).
const SPEED_MIN = 0.5, SPEED_MAX = 1.5, SEMI_MAX = 12, PREROLL = 7200;     // amorce d'entrée (0,15 s) pour chauffer le moteur après un saut
let speed = 1, semis = 0, startMargin = 0.3, pool = null, poolQuality = '', st = null, activeIdx = [], load = 0;
const stretching = () => speed !== 1 || semis !== 0;
const loopA = () => Math.round($('a').value * SR), loopB = () => Math.round($('b').value * SR);
// Boucle effective : celle réglée dans la fenêtre « Boucle » (cases A et B), si elle est activée. Une boucle B <= A est ignorée.
function loopState() { const x = loopA(), y = loopB(); return { on: $('loop').checked && y > x + SR * 0.1, a: x, b: y }; }

let master = null;
const masterValue = () => ($('master').value / 100) ** 2;           // courbe quadratique : réglage plus fin dans les faibles volumes
function buildGains() {                                             // un GainNode par piste, à refaire à chaque nouveau morceau ; toutes passent par le volume général
  gains.forEach(g => g.disconnect());
  gains = tracks.map((t, i) => { const g = ctx.createGain(); g.connect(master); applyGain(i, g); return g; });
}
function ensureCtx() {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: SR });
  master = ctx.createGain(); master.gain.value = masterValue(); master.connect(ctx.destination);
  if (ctx.sampleRate !== SR) msg('Attention : le contexte audio tourne à ' + ctx.sampleRate + ' Hz au lieu de 48000.');
  buildGains();
}
// Muet = case « muet » de la piste, ou une autre piste en solo. Les pistes muettes sont écartées du calcul d'étirement.
const isMuted = i => $('m' + i).checked || (solo.size > 0 && !solo.has(i));
function mixChanged() {                                              // volume, muet ou solo : une piste écartée du calcul puis réactivée en lecture étirée : on relance
  paintTracks();
  tracks.forEach((_, i) => { if (gains[i]) applyGain(i); });
  if (playing && st && tracks.some((_, i) => gains[i] && !activeIdx.includes(i) && !isMuted(i))) startFrom(Math.round(curPos()));
}
function applyGain(i, g = gains[i]) { g.gain.value = isMuted(i) ? 0 : $('v' + i).value / 100; }
// Les icônes ▶ / ⏸ sont des éléments SVG : ils n'ont pas de propriété `hidden` (l'affecter ne change rien à l'écran) ; on passe par l'attribut.
function showEl(el, on) { if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); }
function setPlayLabel(on) { $('play-label').textContent = on ? 'Pause' : 'Lecture'; showEl($('ic-play'), !on); showEl($('ic-pause'), on); }
function stopSources() { live.forEach(s => { s.onended = null; try { s.stop(); } catch (e) {} }); live.clear(); segs = []; endWhen = 0; }
function curPos() {
  if (!playing) return posSample;
  const now = ctx.currentTime; let g = null;
  for (const s of segs) if (s.when <= now) g = s;
  if (!g) return segs.length ? segs[0].sample : posSample;
  if (!g.rate) return Math.min(g.sample + Math.round((now - g.when) * SR), g.sample + g.len);
  let p = Math.min(g.sample + Math.round((now - g.when) * SR * g.rate), g.sample + g.len);   // lecture étirée : la sortie dure len / vitesse
  const L = loopState(); if (L.on && g.sample < L.b && p >= L.b) p = L.a + (p - L.b);        // un bloc peut contenir le raccord de la boucle
  return Math.min(p, dur());
}
// Temps entendu : on retire la latence de sortie pour que paroles et accords tombent avec le son.
const curTime = () => Math.max(0, curPos() / SR - ((playing && ctx && ctx.outputLatency) || 0) * (st ? st.speed : 1));   // latence en secondes réelles = latence × vitesse en secondes du morceau
function pause() {
  if (!playing) return;
  posSample = Math.min(curPos(), dur()); playing = false; gen++;
  clearInterval(timer); stopSources(); setPlayLabel(false); releaseWake();
}
function startFrom(sample) {
  gen++; stopSources(); playing = true;
  // Pistes traitées : toutes à vitesse normale ; étirées, seulement les non muettes (le calcul est le coût principal). Démuter une piste écartée relance la lecture.
  activeIdx = tracks.map((_, i) => i).filter(i => !stretching() || !isMuted(i));
  st = stretching() ? { speed, semis, cumIn: 0, cumOut: 0, kept: 0, pre: 0, fed: [], opened: false, flushed: false, discardLeft: 0, quality: $('stretch-quality').value } : null;
  if (!st) disposePool();
  cursorSample = sample; cursorWhen = ctx.currentTime + startMargin * (st ? 2 : 1);      // marge pour décoder (et étirer) le premier bloc
  setPlayLabel(true); lockWake();                                   // avant pump() : si le premier bloc échoue tout de suite, pause() remet « Lecture »
  clearInterval(timer); timer = setInterval(pump, 150); pump();
}
const srcOf = (fed, n) => { const e = fed.findLast(f => f.n0 <= n) || fed[0]; return e ? Math.max(0, e.src + Math.min(n - e.n0, e.len)) : 0; };   // position source du n-ième échantillon d'entrée
function getPool(quality) {
  if (pool && poolQuality === quality) return pool;
  disposePool();
  if (typeof Worker === 'undefined') throw new Error('Ce navigateur ne permet pas l\'étirement (Worker manquant).');
  pool = createPool(() => new Worker('stretch-worker.js'), Math.max(1, Math.min(3, ((navigator && navigator.hardwareConcurrency) || 2) - 1))); poolQuality = quality;
  return pool;
}
function disposePool() { if (pool) { pool.dispose(); pool = null; poolQuality = ''; } }

// Étire un bloc de `nIn` échantillons source (déjà décodés dans `pcm`, un élément par piste active) : renvoie la sortie, `olen` échantillons par piste.
// Toutes les pistes reçoivent exactement les mêmes longueurs d'entrée et de sortie : leur retard est identique, elles restent alignées.
async function stretchBlock(my, pcm, nIn, srcStart) {
  const n0 = st.cumIn;
  st.cumIn += nIn;
  const nOut = Math.round(st.cumIn / st.speed) - st.cumOut; st.cumOut += nOut;
  const drop = Math.min(st.discardLeft, nOut); st.discardLeft -= drop;
  const olen = nOut - drop;
  const res = pcm.length ? await Promise.all(activeIdx.map((i, k) => pool.process(i, pcm[k][0], pcm[k][1], nOut))) : [];
  if (my !== gen) return null;
  if (res.some(r => r.L.length !== olen)) throw new Error('Désynchronisation interne de l\'étirement.');
  st.fed.push({ n0, src: srcStart, len: nIn }); if (st.fed.length > 12) st.fed.shift();
  const nStart = st.pre + Math.round(st.kept * st.speed); st.kept += olen;
  return { olen, res, src: srcOf(st.fed, nStart) };
}
async function pump() {
  if (pumping || !playing) return;
  pumping = true; const my = gen;
  try {
    while (playing && my === gen && cursorWhen < ctx.currentTime + AHEAD) {
      const D = dur(), L = loopState(), t0 = performance.now();
      if (L.on && cursorSample >= L.b) cursorSample = L.a;
      if (cursorSample >= D) {
        if (!L.on) {
          if (st && st.opened && !st.flushed) {                  // fin du morceau : un bloc de silence fait sortir la fin, retenue par la latence du moteur
            st.flushed = true;
            const fin = Math.round(delayOut(st.speed, st.quality) * st.speed), z = () => [new Float32Array(fin), new Float32Array(fin)];
            const r = await stretchBlock(my, activeIdx.map(z), fin, D); if (!r) return;
            if (r.olen > 0) scheduleBlock(r, fin);
          }
          endWhen = cursorWhen; break;
        }
        cursorSample = L.a;
      }
      let end = Math.min(cursorSample + BLOCK, D);
      if (L.on && cursorSample < L.b) end = Math.min(end, L.b);
      const len = end - cursorSample;
      if (!st) {                                                 // ---- vitesse normale : chemin d'origine ----
        const res = await Promise.all(tracks.map(t => decodeRange(t.p, t.dec, cursorSample, len)));
        if (my !== gen) return;
        if (cursorWhen < ctx.currentTime) { resync(); return; }
        res.forEach((r, i) => {
          const buf = ctx.createBuffer(2, len, SR);
          buf.copyToChannel(r.channelData[0], 0); buf.copyToChannel(r.channelData[1], 1);
          const s = ctx.createBufferSource(); s.buffer = buf; s.connect(gains[i]);
          s.start(cursorWhen);                                   // même instant pour toutes les pistes
          live.add(s); s.onended = () => live.delete(s);
        });
        segs.push({ when: cursorWhen, sample: cursorSample, len }); if (segs.length > 8) segs.shift();
        cursorWhen += len / SR; cursorSample += len;
      } else {                                                   // ---- vitesse ou tonalité modifiée : décodage, étirement, même planification ----
        const p = getPool(st.quality);
        let pre = 0;
        if (!st.opened) {                                        // première fois (ou après un saut) : on repart d'un flux neuf, chauffé par une amorce de source
          pre = Math.min(PREROLL, cursorSample); st.pre = pre; st.discardLeft = delayOut(st.speed, st.quality) + Math.round(pre / st.speed);
          await p.open(activeIdx, { rate: st.speed, semis: st.semis, preroll: pre, preset: st.quality }); if (my !== gen) return;
          st.opened = true;
        }
        const res = await Promise.all(activeIdx.map(i => decodeRange(tracks[i].p, tracks[i].dec, cursorSample - pre, len + pre)));
        if (my !== gen) return;
        const r = await stretchBlock(my, res.map(x => x.channelData), len + pre, cursorSample - pre); if (!r) return;
        if (cursorWhen < ctx.currentTime) { resync(); return; }
        if (r.olen > 0) scheduleBlock(r, len);
        const ms = performance.now() - t0, blockMs = r.olen / SR * 1000;
        if (blockMs > 100) { load = load ? load * 0.7 + (ms / blockMs) * 0.3 : ms / blockMs; showLoad(); }
        cursorSample += len;
      }
      if (L.on && cursorSample >= L.b) cursorSample = L.a;
    }
  } catch (e) { if (my === gen) { msg('Erreur de lecture : ' + e.message); if (st) pause(); } }
  finally { pumping = false; }
}
function resync() {                                              // le calcul n'a pas suivi : on repart avec une marge plus large
  startMargin = Math.min(2, startMargin * 1.5);
  msg('Décodage trop lent : resynchronisation.'); startFrom(cursorSample);
}
function scheduleBlock(r, srcLen) {
  r.res.forEach((x, k) => {
    const buf = ctx.createBuffer(2, r.olen, SR);
    buf.copyToChannel(x.L, 0); buf.copyToChannel(x.R, 1);
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(gains[activeIdx[k]]);
    s.start(cursorWhen);                                         // même instant pour toutes les pistes
    live.add(s); s.onended = () => live.delete(s);
  });
  segs.push({ when: cursorWhen, sample: r.src, len: Math.round(r.olen * st.speed), rate: st.speed }); if (segs.length > 8) segs.shift();
  cursorWhen += r.olen / SR;
}

// ---------------- Métadonnées : grille, accords, paroles, sections ----------------
let M = null, view = [], mapBtns = [], cardEls = [], loopBtns = [], lyEls = [];
let ui = { bb: '', sec: -2, cur: -1, chord: '', line: -2, word: -2, time: '' };
const noMeta = () => { M = null; view = []; ui = { bb: '', sec: -2, cur: -1, chord: '', line: -2, word: -2, time: '' }; renderStructure(); renderLyrics(); $('now').hidden = true; updateTabs(); syncTempoUI(); };

function snapTime(t, mode = $('snap').value) {
  if (!M || !M.beats || mode === 'free') return t;
  return mode === 'bar' ? snapBar(M.beats, t) : snapBeat(M.beats, t);
}
function seekTo(t, snap = true) {
  t = Math.max(0, Math.min(t, dur() / SR)); if (snap) t = snapTime(t);
  posSample = Math.round(t * SR); $('pos').value = posSample; if (playing) startFrom(posSample);
}
const mkEl = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
function setCls(el, cls, on) { const l = new Set(String(el.className || '').split(' ').filter(Boolean)); if (on) l.add(cls); else l.delete(cls); el.className = [...l].join(' '); }
// Trois représentations des sections : carte condensée (écran Mixeur), cartes étalées avec accords et curseur (onglet Structure), cartes de la fenêtre Boucle.
function renderStructure() {
  const map = $('map'), grid = $('struct-grid'), lc = $('loop-cards'); map.innerHTML = ''; grid.innerHTML = ''; lc.innerHTML = '';
  mapBtns = []; cardEls = []; loopBtns = []; ui.sec = -2; ui.cur = -1;
  if (!M || !M.sections) { view = []; map.hidden = true; paintLoop(); return; }
  view = sectionsView(M.sections, $('merge').checked);
  map.hidden = false;
  view.forEach((g, idx) => {
    const m = mkEl('button', '', shortLabel(g.name)); m.type = 'button'; m.style.flexGrow = g.end - g.start;
    m.setAttribute('aria-label', g.name + ', de ' + fmt(g.start) + ' à ' + fmt(g.end) + ', se placer au début'); m.title = g.name + ' ' + fmt(g.start) + '–' + fmt(g.end);
    m.onclick = () => seekTo(g.start, false); map.appendChild(m); mapBtns.push(m);
    const bars = M.beats ? barsInRange(M.beats, g.start, g.end) : 0;
    const c = mkEl('button', 'scard'); c.type = 'button'; c.setAttribute('aria-current', 'false');
    const cr = mkEl('span', 'cr'), cur = mkEl('i', 'cursor'); cur.setAttribute('aria-hidden', 'true');
    c.appendChild(mkEl('span', 'nm', g.name)); c.appendChild(mkEl('span', 'tm', fmt(g.start) + (bars ? ' · ' + bars + ' mesure' + (bars > 1 ? 's' : '') : ''))); c.appendChild(cr); c.appendChild(cur);
    c.onclick = () => seekTo(g.start, false); grid.appendChild(c); cardEls.push({ b: c, cr, cur });
    const l = mkEl('button', ''); l.type = 'button'; l.appendChild(mkEl('span', '', g.name)); l.appendChild(mkEl('small', '', fmt(g.start) + '–' + fmt(g.end)));
    l.setAttribute('aria-label', g.name + ', de ' + fmt(g.start) + ' à ' + fmt(g.end) + '. Toucher : la boucle devient cette section. Appui long : la fin de la boucle se place à la fin de cette section.');
    pressable(l, () => loopCard(idx), () => loopEnd(idx)); lc.appendChild(l); loopBtns.push(l);
  });
  paintCardChords(); paintLoop();
}
function paintCardChords() {                                         // accords de chaque section, dans la notation, le niveau et la transposition choisis
  cardEls.forEach((c, i) => {
    const l = M && M.chords ? chordsInRange(M.chords, view[i].start, view[i].end, pref.notation, pref.level, trFn) : [];
    c.cr.textContent = l.slice(0, 16).join(' ') + (l.length > 16 ? ' …' : '');
  });
}
// ---- Boucle : début et fin réglés par les cartes ; un bouton à deux états l'active ----
function paintLoop() {
  const L = loopState(), a = loopA() / SR, b = loopB() / SR, valid = b > a + 0.1;
  $('btn-loop').setAttribute('aria-pressed', String(L.on)); $('btn-loop-val').textContent = L.on ? fmt(a) + '–' + fmt(b) : 'Désactivée';
  $('btn-loop').setAttribute('aria-label', 'Boucle : ' + (L.on ? 'activée, de ' + fmt(a) + ' à ' + fmt(b) : 'désactivée'));
  $('loop-range').textContent = valid ? 'Boucle : ' + fmtT(a) + ' → ' + fmtT(b) + ' (' + (b - a).toFixed(1) + ' s)' + (L.on ? '' : ' · désactivée') : 'Aucune boucle valide : la fin doit être après le début.';
  view.forEach((g, i) => {
    const inR = valid && g.start >= a - 0.05 && g.end <= b + 0.05;
    setCls(loopBtns[i], 'in-range', inR); setCls(loopBtns[i], 'loop-start', valid && Math.abs(g.start - a) < 0.05); setCls(loopBtns[i], 'loop-end', valid && Math.abs(g.end - b) < 0.05);
    setCls(mapBtns[i], 'in-range', inR && L.on); setCls(cardEls[i].b, 'in-range', inR && L.on);
  });
}
function afterLoopChange(moveInside) {                               // réglage de la boucle modifié : on se replace dedans si besoin, sinon on relance pour appliquer les nouvelles bornes
  paintLoop();
  const t = curTime(), a = loopA() / SR, b = loopB() / SR;
  if (moveInside && $('loop').checked && (t < a || t >= b)) seekTo(a, false); else if (playing) startFrom(Math.round(curPos()));
}
function setLoopRange(a, b) { $('a').value = a.toFixed(2); $('b').value = b.toFixed(2); $('loop').checked = true; }
function loopCard(i) { const r = loopTap(view, i); setLoopRange(r.a, r.b); afterLoopChange(true); toast('Boucle : ' + view[i].name); }
function loopEnd(i) {
  const r = loopLong(view, { a: +$('a').value, b: +$('b').value }, i); setLoopRange(r.a, r.b); afterLoopChange(true);
  if (navigator.vibrate) navigator.vibrate(20); toast('Fin de la boucle : ' + view[i].name);
}
function renderLyrics() {
  const box = $('lyrics'); box.innerHTML = ''; lyEls = []; ui.line = -2; ui.word = -2;
  if (!M || !M.lyrics) { $('lyrics-panel').hidden = true; return; }
  $('lyrics-panel').hidden = false;
  M.lyrics.lines.forEach(l => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ly'; b.setAttribute('aria-current', 'false');
    let spans = [];
    if (l.words.length) spans = l.words.map(w => { const sp = document.createElement('span'); sp.className = 'w'; sp.textContent = w.word + ' '; b.appendChild(sp); return sp; });
    else b.textContent = l.text;
    b.onclick = () => seekTo(Math.max(0, l.start - 0.3), false);   // saut libre : une ligne ne tombe pas forcément sur un temps
    box.appendChild(b); lyEls.push({ b, spans });
  });
}
function scrollLyric(el) {
  const box = $('lyrics'); if (!box.scrollTo) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: reduce ? 'auto' : 'smooth' });
}
// Appelée à chaque image : ne touche au DOM que lorsqu'une valeur change.
function updateMusical(t) {
  if (!M) return;
  const bb = M.beats ? barBeatAt(M.beats, t) : null, bpm = M.bpm ? bpmAt(M.bpm, t) * speed : null;
  const txt = [bb && 'Mesure ' + bb.bar + ' · temps ' + bb.beat, bpm && Math.round(bpm) + ' BPM'].filter(Boolean).join(' · ');
  if (txt !== ui.bb) { ui.bb = txt; $('barbeat').textContent = txt; }
  if (M.chords) {
    const c = chordAt(M.chords, t, pref.notation, pref.level, trFn), key = c.index + '|' + pref.notation + '|' + pref.level + '|' + semis;
    if (key !== ui.chord) {
      ui.chord = key; $('chord-now').textContent = c.now || '–'; $('chord-next').textContent = c.next ? '→ ' + c.next : '';
      $('next-lbl').textContent = c.inBeats ? 'Suivant (dans ' + c.inBeats + ' temps)' : 'Suivant';
    }
  }
  if (view.length) {
    const si = sectionAt(view, t);
    if (si !== ui.sec) {
      ui.sec = si; $('secname').textContent = si >= 0 ? view[si].name : '';
      mapBtns.forEach((b, i) => b.setAttribute('aria-current', String(i === si))); cardEls.forEach((c, i) => c.b.setAttribute('aria-current', String(i === si))); ui.cur = -1;
    }
    if (si >= 0 && shownTab === 'structure') {                      // curseur de lecture dans la carte en cours
      const g = view[si], pct = Math.round((t - g.start) / (g.end - g.start) * 200) / 2;
      if (pct !== ui.cur) { ui.cur = pct; cardEls[si].cur.style.left = pct + '%'; }
    }
  }
  if (M.lyrics) {
    const { line, word } = lyricAt(M.lyrics, t);
    if (line !== ui.line) {
      if (ui.line >= 0 && lyEls[ui.line]) { const o = lyEls[ui.line]; o.b.setAttribute('aria-current', 'false'); o.spans.forEach(sp => { sp.className = 'w'; }); }
      if (line >= 0) { lyEls[line].b.setAttribute('aria-current', 'true'); scrollLyric(lyEls[line].b); }
      ui.line = line; ui.word = -2;
    }
    if (line >= 0 && word !== ui.word) { lyEls[line].spans.forEach((sp, k) => { sp.className = k <= word ? 'w sung' : 'w'; }); ui.word = word; }
  }
}
function tick() {
  if (tracks.length) {
    if (playing && endWhen && ctx.currentTime >= endWhen) { pause(); posSample = 0; }
    const p = curPos(), D = dur();
    if (!dragging) $('pos').value = p;
    const txt = fmtT(p / SR) + ' / ' + fmtT(D / SR);
    if (txt !== ui.time) { ui.time = txt; $('time').textContent = fmt(p / SR); $('time-left').textContent = '-' + fmt(Math.max(0, D - p) / SR); $('pos').setAttribute('aria-valuetext', txt); }
    updateMusical(curTime());
  }
  requestAnimationFrame(tick);
}

// ---------------- Chargement des pistes ----------------
const label = n => n.replace(/\.opus$/i, '').replace(/\.ogg$/i, '');
async function loadFromBytes(list) {                                // list : [{name, bytes}]
  pause(); posSample = 0; semis = 0; tracks.forEach(t => t.dec.free()); tracks = [];
  if (ctx) { gains.forEach(g => g.disconnect()); gains = []; }
  const Dec = window['opus-decoder'] && window['opus-decoder'].OpusDecoder;
  if (!Dec) throw new Error('Décodeur Opus non chargé (fichier vendor/opus-decoder.min.js manquant ?).');
  for (const f of list) {
    const p = parseOggOpus(f.bytes);
    if (p.channels !== 2) throw new Error(f.name + ' : ' + p.channels + ' canaux (stéréo attendu)');
    const dec = new Dec({ channels: 2 }); await dec.ready;
    tracks.push({ name: f.name, p, dec });
  }
  const durs = new Set(tracks.map(t => t.p.durationSamples)), pre = new Set(tracks.map(t => t.p.preSkip));
  const ok = durs.size === 1 && pre.size === 1;
  const encs = new Set(tracks.map(t => { const c = t.p.tags.comments; return c.PROFILE ? 'profil ' + c.PROFILE : (t.p.tags.vendor || 'encodeur inconnu'); }));
  const mixed = encs.size > 1;                                      // pistes encodées avec des encodeurs ou réglages différents
  $('info').className = ok && !mixed ? 'ok' : 'ko';
  $('info').textContent = (ok ? '✔ ' + tracks.length + ' pistes alignées (' + [...durs][0] + ' échantillons).' : '✘ Durées ou pre-skip différents : pistes non alignées.')
    + (mixed ? ' ⚠ Encodages différents : ' + [...encs].join(' ; ') + '.' : ' Encodage : ' + [...encs][0] + '.');
  solo.clear(); buildTrackRows(null);
  if (ctx) buildGains();                                            // contexte déjà créé : reconnecter les nouvelles pistes
  $('pos').max = dur(); $('pos').value = 0; $('pos').disabled = false;
  ['play', 'back10', 'fwd10', 'btn-speed', 'btn-key', 'btn-loop'].forEach(id => { $(id).disabled = false; });
  $('loop').checked = false; $('a').value = '0'; $('b').value = Math.min(4, (dur() / SR).toFixed(1));   // une boucle ne passe pas d'un morceau à l'autre
  paintLoop(); syncTempoUI();
}
function buildTrackRows(keep) {                                       // keep : {m, v} d'un affichage précédent (on reconstruit seulement les boutons)
  const soloBtns = $('solo-btns').checked;
  $('tracks').innerHTML = tracks.map((t, i) => { const k = kindOf(label(t.name)), nm = esc(KIND_LABEL[k] + ' (' + label(t.name) + ')');
    return `<div class="track" id="tr${i}" data-kind="${k}">
    <button type="button" class="ic" id="mb${i}" aria-pressed="false" title="${esc(label(t.name))}">${iconSvg(k)}<span class="solo-badge" aria-hidden="true">S</span></button>
    <input type="range" id="v${i}" min="0" max="100" value="100" aria-label="Volume : ${nm}">
    ${soloBtns ? `<button type="button" class="solo-btn" id="sb${i}" aria-pressed="false" aria-label="Solo : ${nm}">S</button>` : ''}
    <input type="checkbox" id="m${i}" hidden aria-hidden="true" tabindex="-1"></div>`; }).join('');
  tracks.forEach((t, i) => {
    if (keep) { $('m' + i).checked = keep.m[i]; $('v' + i).value = keep.v[i]; }
    else if (/^original/i.test(t.name)) $('m' + i).checked = true;   // le mix original est muet par défaut
    $('v' + i).oninput = $('m' + i).onchange = mixChanged;
    pressable($('mb' + i), () => toggleMute(i), () => toggleSolo(i));   // appui court : muet ; appui long : solo
    if (soloBtns) $('sb' + i).onclick = () => toggleSolo(i);
  });
  paintTracks();
}
function toggleMute(i) { $('m' + i).checked = !$('m' + i).checked; mixChanged(); }
function toggleSolo(i) {
  if (solo.has(i)) solo.delete(i); else solo.add(i);
  if (navigator.vibrate) navigator.vibrate(20);
  mixChanged(); toast((solo.has(i) ? 'Solo : ' : 'Solo retiré : ') + KIND_LABEL[kindOf(label(tracks[i].name))]);
}
function paintTracks() {
  tracks.forEach((t, i) => {
    const row = $('tr' + i), um = $('m' + i).checked, off = isMuted(i), so = solo.has(i), nm = KIND_LABEL[kindOf(label(t.name))];
    if (off) row.setAttribute('data-off', ''); else row.removeAttribute('data-off');
    if (so) row.setAttribute('data-solo', ''); else row.removeAttribute('data-solo');
    const b = $('mb' + i); b.setAttribute('aria-pressed', String(um));
    b.setAttribute('aria-label', nm + (so ? ' : solo actif' : off ? ' : muet' : ' : actif') + '. Appui court : muet. Appui long : solo.');
    if ($('sb' + i)) $('sb' + i).setAttribute('aria-pressed', String(so));
  });
}
$('solo-btns').checked = store.get('soloBtns') === '1';
$('solo-btns').onchange = () => { store.set('soloBtns', $('solo-btns').checked ? '1' : '0'); if (tracks.length) buildTrackRows({ m: tracks.map((_, i) => $('m' + i).checked), v: tracks.map((_, i) => $('v' + i).value) }); };
$('play').onclick = async () => { if (playing) { pause(); return; } ensureCtx(); await ctx.resume(); msg(''); startFrom(posSample); };
$('pos').oninput = () => { dragging = true; };
$('pos').onchange = () => { dragging = false; seekTo(+$('pos').value / SR); };
const goPrevBar = () => { if (!tracks.length) return; seekTo(M && M.beats ? prevBar(M.beats, curTime()) : curTime() - 2, false); };
const goNextBar = () => {
  if (!tracks.length) return;
  if (M && M.beats) { const n = nextBar(M.beats, curTime()); if (n !== null) seekTo(n, false); } else seekTo(curTime() + 2, false);
};
// ⏪ ⏩ : appui court = 10 secondes, toujours calé sur le début d'une mesure ; appui long = début de la section (ou de la précédente) / début de la suivante.
function jump10(dir) {
  if (!tracks.length) return;
  const t = Math.max(0, Math.min(curTime() + dir * 10, dur() / SR));
  seekTo(M && M.beats ? snapBar(M.beats, t) : t, false);
}
function jumpSection(dir) {
  if (!tracks.length) return;
  const j = sectionJump(view, curTime(), dir);
  if (navigator.vibrate) navigator.vibrate(20);
  if (!j) { if (dir < 0) { seekTo(0, false); toast('Début du morceau'); } else toast(view.length ? 'Dernière section' : 'Pas de structure pour ce morceau'); return; }
  seekTo(j.t, false); toast(dir < 0 ? 'Début : ' + j.name : j.name === 'Fin du morceau' ? j.name : 'Section suivante : ' + j.name);
}
pressable($('back10'), () => jump10(-1), () => jumpSection(-1));
pressable($('fwd10'), () => jump10(1), () => jumpSection(1));
$('set-a').onclick = () => { $('a').value = snapTime(curTime()).toFixed(2); msg(''); paintLoop(); };
$('set-b').onclick = () => {
  const v = snapTime(curTime()); $('b').value = v.toFixed(2);
  msg(v <= +$('a').value ? 'Le point B doit être après le point A.' : ''); paintLoop();
};
$('a').onchange = $('b').onchange = () => afterLoopChange(false);
$('loop').onchange = () => afterLoopChange($('loop').checked);
$('btn-loop').onclick = () => { $('loop-manual').open = !view.length; paintLoop(); $('loop-dialog').showModal(); };
$('master').value = store.get('master') || '100'; $('master-val').textContent = $('master').value + ' %';
$('master').oninput = () => { $('master-val').textContent = $('master').value + ' %'; store.set('master', $('master').value); if (master) master.gain.value = masterValue(); };
$('snap').value = store.get('snap') || 'beat'; $('snap').onchange = () => store.set('snap', $('snap').value);
$('merge').checked = store.get('merge') === '1'; $('merge').onchange = () => { store.set('merge', $('merge').checked ? '1' : '0'); renderStructure(); };
$('f').onchange = async e => {
  closeDlg($('songs-dialog'));
  try {
    const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name));
    msg(''); noMeta(); $('song-info').textContent = '';
    await loadFromBytes(await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    setTab('mixer');
  } catch (err) { msg(err.message); }
};
document.addEventListener('keydown', e => {                          // clavier : espace = lecture/pause, flèches = mesure précédente/suivante
  const tag = (e.target && e.target.tagName) || '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !tracks.length || document.querySelector('dialog[open]')) return;
  if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); $('play').onclick(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrevBar(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goNextBar(); }
});

// ---------------- Google Drive + cache ----------------
const cache = createCache();
let drive = null;
const makeDrive = () => { const k = $('key').value.trim(); return k ? createDrive(k) : null; };
$('key').value = store.get('drv_key') || ''; $('root').value = store.get('drv_root') || '';
drive = makeDrive();
cache.purge().then(n => n && status(n + ' fichier(s) inutilisé(s) depuis 45 jours supprimé(s) du cache.'));
cache.persist();

const closeDlg = d => { if (d && d.close) d.close(); };
// Un toucher sur le fond sombre (hors du volet) ferme la fenêtre ; Échap et « Fermer » fonctionnent aussi.
['songs-dialog', 'conv-dialog', 'speed-dialog', 'key-dialog', 'loop-dialog', 'settings'].forEach(id => {
  const d = $(id); if (!d.addEventListener) return;
  d.addEventListener('click', e => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) closeDlg(d);
  });
});
function songButtons(el, items) {
  el.innerHTML = '';
  items.forEach(s => { const b = document.createElement('button'); b.type = 'button'; b.textContent = s.name; b.onclick = () => { closeDlg($('songs-dialog')); openSong(s); }; el.appendChild(b); });
}
async function refreshLocal() {
  const l = await cache.listSongs();
  songButtons($('local'), l);
  if (!l.length) $('local').textContent = 'Aucun morceau enregistré pour l\'instant.';
}
const songsNote = (t, bad) => { const e = $('songs-msg'); e.textContent = t || ''; e.className = bad ? 'err' : 'muted'; };
function saveDrive() {                                               // clé et dossier : enregistrés dès qu'on les modifie dans les Réglages
  const rootId = parseFolderId($('root').value); $('root').value = rootId;     // une adresse Drive collée est réduite à son identifiant
  store.set('drv_key', $('key').value.trim()); store.set('drv_root', rootId);
  drive = makeDrive(); return rootId;
}
$('key').onchange = $('root').onchange = saveDrive;
[$('key'), $('root')].forEach(i => { i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (i.blur) i.blur(); } }; });   // Entrée ne ferme pas les Réglages
$('list').onclick = async () => {
  try {
    songsNote('Lecture de la liste…');
    const rootId = saveDrive();
    if (!drive) throw new Error('Aucune clé API : renseignez-la dans les Réglages.');
    if (!rootId) throw new Error('Aucun dossier racine : renseignez-le dans les Réglages.');
    const songs = await drive.listSongs(rootId);
    if (songs.length) { songButtons($('songs'), songs); songsNote(songs.length + ' morceau(x) sur Drive.'); }
    else { $('songs').innerHTML = ''; songsNote('Aucun morceau terminé (dossier contenant _termine) trouvé.'); }
  } catch (e) { songsNote(e.message, true); }
};
$('open-songs').onclick = () => { refreshLocal(); songsNote(''); $('songs-settings').hidden = !!$('key').value.trim(); $('songs-dialog').showModal(); };
$('songs-to-settings').onclick = () => { closeDlg($('songs-dialog')); $('open-settings').onclick(); };
async function openSong(s) {
  try {
    pause(); msg(''); noMeta(); $('song-info').textContent = '';
    const r = await loadSong(navigator.onLine ? drive : null, cache, s.id, status, s.name);
    await loadFromBytes(r.tracks);
    M = buildMeta(r.meta);
    syncTempoUI();
    renderStructure(); renderLyrics(); updateTabs(); setTab('mixer');
    $('now').hidden = !(M.beats || M.chords);
    status(r.offline ? 'Hors ligne : copie enregistrée sur cet appareil.' : r.fromCache ? r.fromCache + ' piste(s) lue(s) depuis le cache.' : '');
    if (r.warnings.length) msg(r.warnings.join('\n'));
    refreshLocal();
  } catch (e) { status(''); msg(e.message); }
}
refreshLocal();

// ---------------- Vitesse et transposition ----------------
const keyOf = () => (M && M.info && (M.info['tonalité'] || M.info.tonalite)) || '';
function rebuildTranspose() {                                       // écriture des accords transposés : bémols ou dièses selon la tonalité d'arrivée
  keyFlats = spellingFor(keyOf(), semis, M && M.chords && M.chords.acc);
  trFn = (semis && pref.notation !== 'nashville') ? (c => transposeChord(c, semis, keyFlats)) : (c => c);
  ui.chord = ''; paintCardChords();
}
const fmtSemis = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + (Math.abs(n) > 1 ? ' demi-tons' : ' demi-ton');
function songInfoText() {
  if (!M) return '';
  const i = M.info, key = keyOf();
  const keyTxt = key && (semis ? transposeKey(key, semis, keyFlats) + ' (d\'origine : ' + key + ')' : key);
  const bpmTxt = i.bpm && (speed !== 1 ? Math.round(i.bpm * speed) + ' BPM (d\'origine : ' + i.bpm + ')' : i.bpm + ' BPM');
  return [i.titre && (i.artiste ? i.artiste + ' - ' + i.titre : i.titre), bpmTxt, keyTxt, M.beats && M.beats.t.length + ' temps'].filter(Boolean).join(' · ');
}
let tempo = tempoModel(0);                                           // échelle du curseur de vitesse : BPM (tempo d'origine connu) ou pourcentage
const PX = 12;                                                       // largeur d'une graduation de la règle, en pixels
function rulerPos(v) { const r = $('ruler'), x = ((r.clientWidth || 300) / 2 - v * PX) + 'px 100%'; r.style.backgroundPosition = x + ', ' + x; }
function showSpeedValue(v) { $('speed-big').textContent = String(v); $('speed-unit').textContent = tempo.unit; }
function syncTempoUI() {                                            // met l'interface en accord avec `speed` et `semis` (sans toucher à la lecture)
  tempo = tempoModel(M && M.info && parseFloat(M.info.bpm));
  rebuildTranspose();
  const v = tempo.toValue(speed), pct = Math.round(speed * 100), sp = $('speed');
  sp.min = String(tempo.min); sp.max = String(tempo.max); sp.step = '1'; sp.value = String(v); sp.setAttribute('aria-valuetext', v + ' ' + tempo.unit);
  showSpeedValue(v); rulerPos(v);
  $('btn-speed-val').textContent = v + ' ' + tempo.unit;
  $('speed-sub').textContent = tempo.unit === 'BPM' ? pct + ' % de la vitesse d\'origine (' + tempo.orig + ' BPM)' : '';
  $('tempo-reset').disabled = speed === 1; $('semi-reset').disabled = semis === 0;
  $('semi-val').textContent = fmtSemis(semis);
  const key = keyOf(), keyNow = key && (semis ? transposeKey(key, semis, keyFlats) : key);
  $('btn-key-val').textContent = key ? keyNow : (semis ? fmtSemis(semis) : 'Originale');
  // Icônes seules par défaut ; la valeur apparaît sous l'icône (et l'icône prend la couleur d'accent) dès qu'elle diffère de l'original.
  const mod = (el, on) => { if (on) el.setAttribute('data-mod', ''); else el.removeAttribute('data-mod'); };
  mod($('btn-speed'), speed !== 1); mod($('btn-key'), semis !== 0);
  $('btn-speed').setAttribute('aria-label', 'Vitesse : ' + v + ' ' + tempo.unit + (speed !== 1 ? ' (modifiée)' : ''));
  $('btn-key').setAttribute('aria-label', 'Tonalité : ' + (key ? keyNow : (semis ? fmtSemis(semis) : 'originale')) + (semis !== 0 ? ' (transposée)' : ''));
  $('key-line').textContent = key ? (semis ? key + ' → ' + keyNow : key) : 'Tonalité inconnue';
  $('keyname').textContent = key ? 'Tonalité ' + keyNow : '';
  if (!stretching()) { load = 0; $('tempo-info').textContent = ''; }
  $('song-info').textContent = songInfoText();
}
function showLoad() {
  const pct = Math.round(load * 100);
  $('tempo-info').textContent = 'Calcul : ' + pct + ' % du temps disponible' + (load > 0.85 ? ' — juste. Essayez la qualité « économique » (Réglages) ou une vitesse plus proche de l\'original.' : '');
}
let tempoTimer = null;
function tempoChanged() {                                           // un réglage change : on relance la lecture à la position courante (court délai pour regrouper les appuis)
  syncTempoUI(); clearTimeout(tempoTimer);
  tempoTimer = setTimeout(() => { if (playing) startFrom(Math.round(curPos())); else if (!stretching()) disposePool(); }, 150);
}
const setSemis = n => { semis = Math.max(-SEMI_MAX, Math.min(SEMI_MAX, n)); tempoChanged(); };
{ const v = parseFloat(store.get('speed')); if (v >= SPEED_MIN && v <= SPEED_MAX) speed = Math.round(v * 1e4) / 1e4; }   // la vitesse est mémorisée, pas la transposition
function setSpeedValue(v) {                                         // valider une valeur du curseur (BPM ou %)
  v = Math.max(tempo.min, Math.min(tempo.max, Math.round(v)));
  speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, tempo.toSpeed(v)));
  store.set('speed', String(Math.round(speed * 1e4) / 1e4)); tempoChanged();
}
$('speed').oninput = () => { const v = Math.round($('speed').value); showSpeedValue(v); rulerPos(v); };
$('speed').onchange = () => setSpeedValue(+$('speed').value);
$('tempo-m2').onclick = () => setSpeedValue(tempo.toValue(speed) - 2); $('tempo-p2').onclick = () => setSpeedValue(tempo.toValue(speed) + 2);
$('tempo-reset').onclick = () => { speed = 1; store.set('speed', '1'); tempoChanged(); };
// Règle : on la fait glisser ; vers la droite le tempo baisse, vers la gauche il monte, une graduation par unité. La valeur est appliquée au relâchement.
let rdrag = null;
{ const r = $('ruler');
  r.onpointerdown = e => { rdrag = { x: e.clientX, v: +$('speed').value, cur: null }; if (r.setPointerCapture && e.pointerId !== undefined) { try { r.setPointerCapture(e.pointerId); } catch (x) {} } };
  r.onpointermove = e => { if (!rdrag) return; const v = Math.max(tempo.min, Math.min(tempo.max, rdrag.v - (e.clientX - rdrag.x) / PX)); rdrag.cur = v; showSpeedValue(Math.round(v)); rulerPos(v); };
  r.onpointerup = r.onpointercancel = () => { if (!rdrag) return; const v = rdrag.cur; rdrag = null; if (v !== null) setSpeedValue(v); }; }
$('semi-m2').onclick = () => setSemis(semis - 2); $('semi-m1').onclick = () => setSemis(semis - 1);
$('semi-p1').onclick = () => setSemis(semis + 1); $('semi-p2').onclick = () => setSemis(semis + 2);
$('semi-reset').onclick = () => setSemis(0);
$('btn-speed').onclick = () => { $('speed-dialog').showModal(); syncTempoUI(); };      // la règle se cale sur sa largeur réelle une fois la fenêtre affichée
$('btn-key').onclick = () => $('key-dialog').showModal();
$('stretch-quality').value = store.get('stretchQuality') || 'default';
$('stretch-quality').onchange = () => { store.set('stretchQuality', $('stretch-quality').value); if (playing && st) startFrom(Math.round(curPos())); };
syncTempoUI();

// ---------------- Écran principal : onglets en bas, bulle d'information, mode gaucher, écran allumé ----------------
// Mixeur (accords, structure condensée, pistes, commandes), Structure (cartes étalées), Paroles, Guitare (à venir), Menu. Rien n'est détruit en changeant d'onglet :
// les pages sont seulement masquées et l'affichage continue de se mettre à jour. La barre de lecture (position, temps, commandes, volume général) est commune à tous les écrans.
const TABS = ['mixer', 'structure', 'lyrics', 'guitar', 'menu'];
const tabAvailable = { mixer: () => true, structure: () => !!(M && M.sections), lyrics: () => !!(M && M.lyrics), guitar: () => false, menu: () => true };
function setTab(v, remember = true) {
  shownTab = v;
  TABS.forEach(x => { $('tab-' + x).setAttribute('aria-selected', String(x === v)); $('page-' + x).hidden = x !== v; });
  if (v === 'lyrics' && ui.line >= 0 && lyEls[ui.line]) scrollLyric(lyEls[ui.line].b);       // la zone était masquée : on recentre la ligne en cours
  if (v === 'structure') ui.cur = -1;
  if (remember) { curTab = v; store.set('tab', v); $('pages').scrollTop = 0; }
}
function updateTabs() {                                             // morceau changé : onglets sans contenu grisés, repli sur le Mixeur
  const ok = {}; TABS.forEach(v => { ok[v] = tabAvailable[v](); $('tab-' + v).disabled = !ok[v]; });
  setTab(ok[curTab] ? curTab : 'mixer', false);
}
TABS.forEach(v => { $('tab-' + v).onclick = () => { if (!$('tab-' + v).disabled) setTab(v); }; });
$('tabbar').onkeydown = e => {                                      // flèches : onglet voisin (dans l'ordre affiché, donc inversé en mode gaucher)
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const order = [...TABS]; if (document.body && document.body.getAttribute && document.body.getAttribute('data-hand') === 'left') order.reverse();
  const en = order.filter(v => !$('tab-' + v).disabled); if (!en.length) return;
  e.preventDefault();
  const n = en[(Math.max(en.indexOf(shownTab), 0) + (e.key === 'ArrowRight' ? 1 : -1) + en.length) % en.length];
  setTab(n); if ($('tab-' + n).focus) $('tab-' + n).focus();
};
let toastTimer = null;
function toast(t) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { e.hidden = true; }, 2200); }
// Mode gaucher : l'ordre des onglets est inversé (dans le DOM, pour que Tab et les lecteurs d'écran suivent l'ordre affiché) ; le CSS met le reste en miroir.
function setHand(left, remember = true) {
  if (document.body && document.body.setAttribute) document.body.setAttribute('data-hand', left ? 'left' : 'right');
  (left ? [...TABS].reverse() : TABS).forEach(v => $('tabbar').appendChild($('tab-' + v)));
  if (remember) store.set('lefty', left ? '1' : '0');
}
$('lefty').checked = store.get('lefty') === '1'; setHand($('lefty').checked, false);
$('lefty').onchange = () => setHand($('lefty').checked);
// Écran allumé pendant la lecture (Wake Lock) : demandé au démarrage, relâché à la pause, redemandé au retour sur l'application.
let wakeLock = null;
async function lockWake() {
  if (!$('wake').checked || wakeLock || !navigator.wakeLock) return;
  try {
    const l = await navigator.wakeLock.request('screen');
    if (!playing || !$('wake').checked) { try { l.release(); } catch (e) {} return; }
    wakeLock = l; if (l.addEventListener) l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
function releaseWake() { if (wakeLock) { const l = wakeLock; wakeLock = null; try { l.release(); } catch (e) {} } }
$('wake').checked = store.get('wake') !== '0';
if (!navigator.wakeLock) { $('wake').disabled = true; $('wake-note').textContent = 'Non pris en charge par ce navigateur.'; }
$('wake').onchange = () => { store.set('wake', $('wake').checked ? '1' : '0'); if (!$('wake').checked) releaseWake(); else if (playing) lockWake(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && playing) lockWake(); });
updateTabs();

// ---------------- Réglages : thèmes, accords, version, cache ----------------
const settings = $('settings');
$('ver').textContent = self.APP_VERSION || '?';
function fillThemes() {
  $('theme').innerHTML = [{ id: 'auto', label: 'Automatique (réglage du système)' }, ...T.list()].map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  $('theme').value = T.saved();
}
fillThemes();
$('theme').onchange = () => { T.save($('theme').value); T.apply($('theme').value); };
$('chord-notation').value = pref.notation; $('chord-level').value = pref.level;
$('chord-notation').onchange = () => { pref.notation = $('chord-notation').value; store.set('chordNotation', pref.notation); rebuildTranspose(); };
$('chord-level').onchange = () => { pref.level = $('chord-level').value; store.set('chordLevel', pref.level); ui.chord = ''; paintCardChords(); };
async function showStorage() {
  const u = await cache.usage();
  $('storage').textContent = u ? 'Stockage utilisé : ' + (u.used / 1e6).toFixed(0) + ' Mo' + (u.quota ? ' sur ' + (u.quota / 1e9).toFixed(1) + ' Go disponibles' : '') + '.' : '';
}
$('open-settings').onclick = () => { fillThemes(); showStorage(); settings.showModal(); };
$('open-converter').onclick = () => { closeDlg(settings); $('conv-dialog').showModal(); };
$('clear-cache').onclick = async () => { await cache.clear(); await refreshLocal(); await showStorage(); status('Cache audio vidé.'); };

// ---------------- Mises à jour (service worker) ----------------
let swReg = null;
function offerUpdate() {
  $('update').hidden = false;
  fetch('version.js', { cache: 'no-store' }).then(r => r.text()).then(t => {
    const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(t);
    if (m) $('update-text').textContent = 'La version ' + m[1] + ' est disponible (vous utilisez la ' + self.APP_VERSION + ').';
  }).catch(() => {});
}
$('update-go').onclick = () => { if (swReg && swReg.waiting) swReg.waiting.postMessage('SKIP_WAITING'); };
$('check-update').onclick = async () => {
  if (!swReg) { $('storage').textContent = 'Mises à jour indisponibles (service worker non actif).'; return; }
  $('storage').textContent = 'Recherche…';
  try { await swReg.update(); } catch (e) { $('storage').textContent = 'Impossible de vérifier (hors ligne ?).'; return; }
  $('storage').textContent = (swReg.waiting || swReg.installing) ? 'Une nouvelle version est prête.' : 'Vous avez la dernière version (' + self.APP_VERSION + ').';
};
async function initSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  try { swReg = await navigator.serviceWorker.register('sw.js'); } catch (e) { return; }
  if (swReg.waiting && hadController) offerUpdate();
  swReg.addEventListener('updatefound', () => {
    const w = swReg.installing;
    w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(); });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadController || reloading) return; reloading = true; location.reload(); });
  setInterval(() => swReg.update().catch(() => {}), 3600e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) swReg.update().catch(() => {}); });
}
initSW();
noMeta();
requestAnimationFrame(tick);
