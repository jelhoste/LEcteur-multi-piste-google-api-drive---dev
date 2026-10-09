import { parseOggOpus, decodeRange } from './ogg-opus.js';
import { createDrive, createCache, loadSong, parseFolderId } from './drive.js';
import { buildMeta, snapBeat, snapBar, barBeatAt, prevBar, nextBar, chordAt, bpmAt, lyricAt, sectionsView, sectionAt, shortLabel, transposeChord, transposeKey, spellingFor } from './meta.js';
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
let trFn = x => x, keyFlats = false;                                // transposition des accords à l'affichage (la notation Nashville, relative à la tonalité, ne change pas)

// ---------------- Lecteur ----------------
let ctx = null, tracks = [], gains = [], playing = false, gen = 0, pumping = false, timer = null;
let segs = [], live = new Set(), cursorSample = 0, cursorWhen = 0, posSample = 0, endWhen = 0, dragging = false;
const dur = () => Math.min(...tracks.map(t => t.p.durationSamples));
const loopA = () => Math.round($('a').value * SR), loopB = () => Math.round($('b').value * SR);
// Vitesse (time stretch, hauteur conservée) et transposition : réglages globaux, identiques pour toutes les pistes (sinon elles se décaleraient).
// À 100 % et 0 demi-ton, le chemin de lecture ci-dessous est strictement l'ancien (aucun calcul ajouté).
const SPEED_MIN = 0.5, SPEED_MAX = 1.5, SEMI_MAX = 12, PREROLL = 7200;     // amorce d'entrée (0,15 s) pour chauffer le moteur après un saut
let speed = 1, semis = 0, startMargin = 0.3, pool = null, poolQuality = '', st = null, activeIdx = [], load = 0;
const stretching = () => speed !== 1 || semis !== 0;
let selSection = -1;                                                // section sélectionnée dans la carte (indice dans `view`), -1 = aucune
// Boucle effective : la section sélectionnée si « Boucler la section » est coché, sinon la boucle manuelle A-B. Une boucle B <= A est ignorée.
function loopState() {
  if ($('secloop').checked && selSection >= 0 && view[selSection]) {
    const g = view[selSection];
    return { on: true, a: Math.round(g.start * SR), b: Math.round(Math.min(g.end, dur() / SR) * SR) };
  }
  const x = loopA(), y = loopB();
  return { on: $('loop').checked && y > x + SR * 0.1, a: x, b: y };
}

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
function onMix(i) {                                                  // volume / muet ; une piste écartée du calcul (muette) puis démutée en lecture étirée : on relance
  return () => { if (!gains[i]) return; applyGain(i); if (playing && st && !activeIdx.includes(i) && !$('m' + i).checked) startFrom(Math.round(curPos())); };
}
function applyGain(i, g = gains[i]) { g.gain.value = $('m' + i).checked ? 0 : $('v' + i).value / 100; }
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
  clearInterval(timer); stopSources(); $('play').textContent = '▶ Lecture';
}
function startFrom(sample) {
  gen++; stopSources(); playing = true;
  // Pistes traitées : toutes à vitesse normale ; étirées, seulement les non muettes (le calcul est le coût principal). Démuter une piste écartée relance la lecture.
  activeIdx = tracks.map((_, i) => i).filter(i => !stretching() || !$('m' + i).checked);
  st = stretching() ? { speed, semis, cumIn: 0, cumOut: 0, kept: 0, pre: 0, fed: [], opened: false, flushed: false, discardLeft: 0, quality: $('stretch-quality').value } : null;
  if (!st) disposePool();
  cursorSample = sample; cursorWhen = ctx.currentTime + startMargin * (st ? 2 : 1);      // marge pour décoder (et étirer) le premier bloc
  $('play').textContent = '⏸ Pause';                              // avant pump() : si le premier bloc échoue tout de suite, pause() remet « Lecture »
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
let M = null, view = [], mapBtns = [], listBtns = [], lyEls = [];
let ui = { bb: '', sec: -2, chord: '', line: -2, word: -2, time: '' };
const noMeta = () => { M = null; view = []; ui = { bb: '', sec: -2, chord: '', line: -2, word: -2, time: '' }; renderStructure(); renderLyrics(); $('now').hidden = true; };

function snapTime(t, mode = $('snap').value) {
  if (!M || !M.beats || mode === 'free') return t;
  return mode === 'bar' ? snapBar(M.beats, t) : snapBeat(M.beats, t);
}
function seekTo(t, snap = true) {
  t = Math.max(0, Math.min(t, dur() / SR)); if (snap) t = snapTime(t);
  posSample = Math.round(t * SR); $('pos').value = posSample; if (playing) startFrom(posSample);
}
// Toucher une carte sélectionne la section (et s'y place) ; si « Boucler la section » est coché, elle tourne en boucle. Retoucher la même carte la désélectionne.
function selectSection(i) {
  const was = selSection;
  selSection = (i === was) ? -1 : i;
  updateSelectionUI();
  if (selSection >= 0) seekTo(view[selSection].start, false);
  else if (playing) startFrom(Math.round(curPos()));               // désélection : la boucle s'arrête tout de suite
}
function updateSelectionUI() {
  mapBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(k === selSection))); listBtns.forEach((b, k) => b.setAttribute('aria-pressed', String(k === selSection)));
  const g = view[selSection];
  $('secloop-label').textContent = g ? 'Section sélectionnée : ' + g.name + ' (' + fmt(g.start) + '–' + fmt(g.end) + ')' + ($('secloop').checked ? ' · en boucle' : ' · boucle désactivée') : 'Aucune section sélectionnée';
  $('secrow').hidden = !view.length;
}

function renderStructure() {
  const map = $('map'), list = $('secs'); map.innerHTML = ''; list.innerHTML = ''; mapBtns = []; listBtns = []; ui.sec = -2; selSection = -1;
  if (!M || !M.sections) { view = []; map.hidden = true; $('seclist').hidden = true; updateSelectionUI(); return; }
  view = sectionsView(M.sections, $('merge').checked);
  map.hidden = false; $('seclist').hidden = false;
  view.forEach((g, idx) => {
    const btn = () => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-pressed', 'false'); b.onclick = () => selectSection(idx); return b; };
    const m = btn(); m.textContent = shortLabel(g.name); m.style.flexGrow = g.end - g.start;
    m.setAttribute('aria-label', g.name + ', de ' + fmt(g.start) + ' à ' + fmt(g.end) + ', boucler cette section'); m.title = g.name + ' ' + fmt(g.start) + '–' + fmt(g.end);
    map.appendChild(m); mapBtns.push(m);
    const l = btn(); l.textContent = g.name + ' ' + fmt(g.start); list.appendChild(l); listBtns.push(l);
  });
  const off = document.createElement('button'); off.type = 'button'; off.textContent = 'Sans boucle'; off.onclick = () => { $('loop').checked = false; if (selSection >= 0) selectSection(selSection); else if (playing) startFrom(Math.round(curPos())); };
  list.appendChild(off); updateSelectionUI();
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
      mapBtns.forEach((b, i) => b.setAttribute('aria-current', String(i === si))); listBtns.forEach((b, i) => b.setAttribute('aria-current', String(i === si)));
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
    if (txt !== ui.time) { ui.time = txt; $('time').textContent = txt; $('pos').setAttribute('aria-valuetext', txt); }
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
  $('tracks').innerHTML = tracks.map((t, i) => `<div class="track"><span class="n">${esc(label(t.name))}</span>
    <input type="range" id="v${i}" min="0" max="100" value="100" aria-label="Volume ${esc(label(t.name))}">
    <label class="chk"><input type="checkbox" id="m${i}"> Muet</label></div>`).join('');
  tracks.forEach((t, i) => {
    if (/^original/i.test(t.name)) $('m' + i).checked = true;       // le mix original est muet par défaut
    $('v' + i).oninput = $('m' + i).onchange = onMix(i);
  });
  if (ctx) buildGains();                                            // contexte déjà créé : reconnecter les nouvelles pistes
  $('pos').max = dur(); $('pos').value = 0; $('pos').disabled = false; $('play').disabled = false;
  $('b').value = Math.min(4, (dur() / SR).toFixed(1));
  syncTempoUI();
}
$('play').onclick = async () => { if (playing) { pause(); return; } ensureCtx(); await ctx.resume(); msg(''); startFrom(posSample); };
$('pos').oninput = () => { dragging = true; };
$('pos').onchange = () => { dragging = false; seekTo(+$('pos').value / SR); };
$('prev-bar').onclick = () => { if (!tracks.length) return; seekTo(M && M.beats ? prevBar(M.beats, curTime()) : curTime() - 2, false); };
$('next-bar').onclick = () => {
  if (!tracks.length) return;
  if (M && M.beats) { const n = nextBar(M.beats, curTime()); if (n !== null) seekTo(n, false); } else seekTo(curTime() + 2, false);
};
$('set-a').onclick = () => { $('a').value = snapTime(curTime()).toFixed(2); msg(''); };
$('set-b').onclick = () => {
  const v = snapTime(curTime()); $('b').value = v.toFixed(2);
  msg(v <= +$('a').value ? 'Le point B doit être après le point A.' : '');
};
$('secloop').checked = store.get('secloop') !== '0';                 // par défaut : toucher une section la met en boucle (comportement précédent)
$('secloop').onchange = () => {
  store.set('secloop', $('secloop').checked ? '1' : '0');
  if ($('secloop').checked && selSection < 0 && view.length) { const si = sectionAt(view, curTime()); if (si >= 0) selSection = si; }   // rien de sélectionné : on prend la section en cours
  updateSelectionUI(); if (playing) startFrom(Math.round(curPos()));
};
$('master').value = store.get('master') || '100'; $('master-val').textContent = $('master').value + ' %';
$('master').oninput = () => { $('master-val').textContent = $('master').value + ' %'; store.set('master', $('master').value); if (master) master.gain.value = masterValue(); };
$('loop').onchange = () => { if (playing) startFrom(Math.round(curPos())); };
$('snap').value = store.get('snap') || 'beat'; $('snap').onchange = () => store.set('snap', $('snap').value);
$('merge').checked = store.get('merge') === '1'; $('merge').onchange = () => { store.set('merge', $('merge').checked ? '1' : '0'); renderStructure(); };
$('f').onchange = async e => {
  try {
    const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name));
    msg(''); noMeta(); $('song-info').textContent = '';
    await loadFromBytes(await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
  } catch (err) { msg(err.message); }
};
document.addEventListener('keydown', e => {                          // clavier : espace = lecture/pause, flèches = mesure précédente/suivante
  const tag = (e.target && e.target.tagName) || '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey || !tracks.length) return;
  if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); $('play').onclick(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); $('prev-bar').onclick(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); $('next-bar').onclick(); }
});

// ---------------- Google Drive + cache ----------------
const cache = createCache();
let drive = null;
const makeDrive = () => { const k = $('key').value.trim(); return k ? createDrive(k) : null; };
$('key').value = store.get('drv_key') || ''; $('root').value = store.get('drv_root') || '';
drive = makeDrive();
cache.purge().then(n => n && status(n + ' fichier(s) inutilisé(s) depuis 45 jours supprimé(s) du cache.'));
cache.persist();

function songButtons(el, items) {
  el.innerHTML = '';
  items.forEach(s => { const b = document.createElement('button'); b.type = 'button'; b.textContent = s.name; b.onclick = () => openSong(s); el.appendChild(b); });
}
async function refreshLocal() {
  const l = await cache.listSongs();
  songButtons($('local'), l);
  if (!l.length) $('local').textContent = 'Aucun morceau enregistré pour l\'instant.';
}
$('list').onclick = async () => {
  try {
    msg(''); status('Lecture de la liste…');
    const rootId = parseFolderId($('root').value); $('root').value = rootId;     // une adresse Drive collée est réduite à son identifiant
    store.set('drv_key', $('key').value.trim()); store.set('drv_root', rootId);
    drive = makeDrive();
    if (!drive) throw new Error('Saisissez une clé API.');
    const songs = await drive.listSongs(rootId);
    if (songs.length) songButtons($('songs'), songs); else $('songs').textContent = 'Aucun morceau terminé (dossier contenant _termine) trouvé.';
    status('');
  } catch (e) { status(''); msg(e.message); }
};
async function openSong(s) {
  try {
    pause(); msg(''); noMeta(); $('song-info').textContent = '';
    const r = await loadSong(navigator.onLine ? drive : null, cache, s.id, status, s.name);
    await loadFromBytes(r.tracks);
    M = buildMeta(r.meta);
    syncTempoUI();
    renderStructure(); renderLyrics();
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
  ui.chord = '';
}
const fmtSemis = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + (Math.abs(n) > 1 ? ' demi-tons' : ' demi-ton');
function songInfoText() {
  if (!M) return '';
  const i = M.info, key = keyOf();
  const keyTxt = key && (semis ? transposeKey(key, semis, keyFlats) + ' (d\'origine : ' + key + ')' : key);
  const bpmTxt = i.bpm && (speed !== 1 ? Math.round(i.bpm * speed) + ' BPM (d\'origine : ' + i.bpm + ')' : i.bpm + ' BPM');
  return [i.titre && (i.artiste ? i.artiste + ' - ' + i.titre : i.titre), bpmTxt, keyTxt, M.beats && M.beats.t.length + ' temps'].filter(Boolean).join(' · ');
}
function syncTempoUI() {                                            // met l'interface en accord avec `speed` et `semis` (sans toucher à la lecture)
  const pct = Math.round(speed * 100);
  $('speed').value = String(pct); $('speed').setAttribute('aria-valuetext', pct + ' %'); $('speed-val').textContent = pct + ' %';
  $('semi-val').textContent = fmtSemis(semis);
  $('tempo-sum').textContent = 'Vitesse et transposition' + (stretching() ? ' : ' + pct + ' %, ' + fmtSemis(semis) : '');
  $('tempo-reset').disabled = !stretching();
  if (!stretching()) { load = 0; $('tempo-info').textContent = ''; }
  rebuildTranspose();
  $('song-info').textContent = songInfoText();
  const key = keyOf(); $('keyname').textContent = key ? 'Tonalité ' + (semis ? transposeKey(key, semis, keyFlats) : key) : '';
}
function showLoad() {
  const pct = Math.round(load * 100);
  $('tempo-info').textContent = 'Calcul : ' + pct + ' % du temps disponible' + (load > 0.85 ? ' — juste. Essayez la qualité « économique » (Réglages) ou une vitesse plus proche de 100 %.' : '');
}
let tempoTimer = null;
function tempoChanged() {                                           // un réglage change : on relance la lecture à la position courante (court délai pour regrouper les appuis)
  syncTempoUI(); clearTimeout(tempoTimer);
  tempoTimer = setTimeout(() => { if (playing) startFrom(Math.round(curPos())); else if (!stretching()) disposePool(); }, 150);
}
const setSemis = n => { semis = Math.max(-SEMI_MAX, Math.min(SEMI_MAX, n)); tempoChanged(); };
{ const v = parseFloat(store.get('speed')); if (v >= SPEED_MIN && v <= SPEED_MAX) speed = Math.round(v * 20) / 20; }   // la vitesse est mémorisée, pas la transposition
$('speed').oninput = () => { $('speed-val').textContent = Math.round($('speed').value) + ' %'; };
$('speed').onchange = () => { speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round($('speed').value) / 100)); store.set('speed', String(speed)); tempoChanged(); };
$('semi-m2').onclick = () => setSemis(semis - 2); $('semi-m1').onclick = () => setSemis(semis - 1);
$('semi-p1').onclick = () => setSemis(semis + 1); $('semi-p2').onclick = () => setSemis(semis + 2);
$('tempo-reset').onclick = () => { speed = 1; semis = 0; store.set('speed', '1'); tempoChanged(); };
$('stretch-quality').value = store.get('stretchQuality') || 'default';
$('stretch-quality').onchange = () => { store.set('stretchQuality', $('stretch-quality').value); if (playing && st) startFrom(Math.round(curPos())); };
syncTempoUI();

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
$('chord-level').onchange = () => { pref.level = $('chord-level').value; store.set('chordLevel', pref.level); ui.chord = ''; };
async function showStorage() {
  const u = await cache.usage();
  $('storage').textContent = u ? 'Stockage utilisé : ' + (u.used / 1e6).toFixed(0) + ' Mo' + (u.quota ? ' sur ' + (u.quota / 1e9).toFixed(1) + ' Go disponibles' : '') + '.' : '';
}
$('open-settings').onclick = () => { fillThemes(); showStorage(); settings.showModal(); };
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
