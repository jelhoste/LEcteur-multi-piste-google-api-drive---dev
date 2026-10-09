// meta.js : transforme les JSON du morceau en structures prêtes à interroger (grille de temps, accords, paroles, sections).
// Tolérant : chaque partie absente ou illisible donne null, l'interface masque alors la fonctionnalité correspondante.

const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;

// Plus grand indice i tel que arr[i] <= x ; -1 si x est avant le premier élément.
export function lastLE(arr, x) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
// Plus petit indice i tel que arr[i] > x ; arr.length si aucun.
export function firstGT(arr, x) { return lastLE(arr, x) + 1; }

// ---------- grille de temps ----------
function buildBeats(meta) {
  let times = [], nums = [];
  if (Array.isArray(meta.beats)) for (const b of meta.beats) if (b && num(b.time) !== null) { times.push(b.time); nums.push(b.beatNum | 0); }
  if (!times.length && Array.isArray(meta.chords))                       // repli : la grille des accords
    for (const c of meta.chords) if (c && num(c.curr_beat_time) !== null) { times.push(c.curr_beat_time); nums.push(c.beat_num | 0); }
  if (!times.length) return null;
  const t = Float64Array.from(times), bar = new Int32Array(t.length), starts = [];
  let b = 0;
  for (let i = 0; i < t.length; i++) { if (nums[i] === 1) { b++; starts.push(t[i]); } bar[i] = b; }
  return { t, n: Uint8Array.from(nums), bar, barStarts: Float64Array.from(starts) };
}
export function nearestIndex(arr, x) {
  const i = lastLE(arr, x);
  if (i < 0) return 0; if (i >= arr.length - 1) return arr.length - 1;
  return (x - arr[i] <= arr[i + 1] - x) ? i : i + 1;
}
export const snapBeat = (g, t) => g.t[nearestIndex(g.t, t)];
export const snapBar = (g, t) => g.barStarts.length ? g.barStarts[nearestIndex(g.barStarts, t)] : snapBeat(g, t);
export function barBeatAt(g, t) { const i = lastLE(g.t, t); return i < 0 ? null : { bar: g.bar[i], beat: g.n[i], index: i }; }
export function prevBar(g, t) { const i = lastLE(g.barStarts, t - 0.25); return g.barStarts[Math.max(0, i)]; }
export function nextBar(g, t) { const i = firstGT(g.barStarts, t + 0.05); return i < g.barStarts.length ? g.barStarts[i] : null; }

// ---------- accords ----------
function buildChords(meta) {
  if (!Array.isArray(meta.chords) || !meta.chords.length) return null;
  const list = meta.chords.filter(c => c && num(c.curr_beat_time) !== null).sort((a, b) => a.curr_beat_time - b.curr_beat_time);
  if (!list.length) return null;
  const acc = { flats: 0, sharps: 0 };                                    // écriture d'origine : bémols ou dièses (sert à choisir l'écriture après transposition)
  for (const c of list) { const m = /^[A-G]([#♯b♭])/.exec(String(c.chord_simple_pop ?? c.chord_basic_pop ?? '')); if (m) { if (/[b♭]/.test(m[1])) acc.flats++; else acc.sharps++; } }
  return { list, t: Float64Array.from(list.map(c => c.curr_beat_time)), acc };
}
// notation : 'pop' | 'jazz' | 'nashville' ; level : 'basic' | 'simple' | 'complex'
export function chordText(c, notation, level) {
  if (!c) return '';
  const key = 'chord_' + level + '_' + notation;
  let s = c[key] ?? c['chord_simple_' + notation] ?? c.chord_simple_pop ?? '';
  const bass = notation === 'nashville' ? c.bass_nashville : c.bass;
  if (s && bass && bass !== s) s += '/' + bass;
  return String(s);
}
// Accord courant, accord suivant différent, et nombre de temps avant le changement.
// `tr` : fonction de transposition appliquée à l'affichage (identité par défaut). La recherche du changement d'accord se fait sur les noms d'origine.
export function chordAt(ch, t, notation, level, tr = x => x) {
  const i = lastLE(ch.t, t);
  if (i < 0) return { index: -1, now: '', next: tr(chordText(ch.list[0], notation, level)), inBeats: null };
  const now = chordText(ch.list[i], notation, level);
  let j = i + 1;
  while (j < ch.list.length && chordText(ch.list[j], notation, level) === now) j++;
  return { index: i, now: tr(now), next: j < ch.list.length ? tr(chordText(ch.list[j], notation, level)) : '', inBeats: j < ch.list.length ? j - i : null };
}

// ---------- transposition (accords et tonalité) ----------
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FR_SHARP = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const FR_FLAT = ['Do', 'Réb', 'Ré', 'Mib', 'Mi', 'Fa', 'Solb', 'Sol', 'Lab', 'La', 'Sib', 'Si'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FR_PC = { do: 0, re: 2, 'ré': 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 };
const accVal = a => (a === '#' || a === '♯') ? 1 : (a === 'b' || a === '♭') ? -1 : 0;
const mod12 = n => ((n % 12) + 12) % 12;
const glyphs = (name, uni) => uni ? name.replace('#', '♯').replace(/(?<=.)b/, '♭') : name;

// Transpose un nom d'accord de `semis` demi-tons (« Am7/G » -> « Bm7/A » pour +2). La qualité (m7, sus4, add9…) est conservée.
// `flats` : écrire les altérations en bémols (true) ou en dièses (false). Tout ce qui n'est pas un accord (« N.C. ») est rendu tel quel.
export function transposeChord(s, semis, flats) {
  if (!s || !semis) return s;
  return String(s).split('/').map((part, k) => {
    const m = (k === 0 ? /^([A-G])([#♯b♭]?)(.*)$/ : /^([A-G])([#♯b♭]?)$/).exec(part);
    if (!m) return part;                                                   // pas une note : « 9 » de C6/9, « N.C. »…
    return glyphs((flats ? FLAT : SHARP)[mod12(LETTER[m[1]] + accVal(m[2]) + semis)], /[♯♭]/.test(m[2])) + (m[3] || '');
  }).join('/');
}
// Lit une tonalité : « Sol majeur », « Mi♭ mineur », « F# minor », « Am »… -> { pc, minor, fr, accent, uni } ou null.
export function parseKey(s) {
  const m = /^\s*(do|ré|re|mi|fa|sol|la|si|[A-Ga-g])(?:(#|♯|b|♭)|\s+(dièse|diese|bémol|bemol)(?![a-zà-ÿ]))?(\s*)(.*)$/i.exec(String(s || ''));
  if (!m) return null;
  const name = m[1].toLowerCase(), fr = name.length > 1;
  const pc = fr ? FR_PC[name] : LETTER[m[1].toUpperCase()];
  if (pc === undefined) return null;
  const a = m[2] || m[3], acc = a ? ({ '#': 1, '♯': 1, 'dièse': 1, 'diese': 1 }[a.toLowerCase()] ?? -1) : 0;
  return { pc: mod12(pc + acc), minor: /^(m(?!a)|min)/i.test(m[5]), fr, accent: !/^re$/i.test(m[1]), uni: /[♯♭]/.test(m[2] || ''), sep: m[4], rest: m[5].trim(), original: String(s).trim() };
}
// Bémols ou dièses après transposition ? Tonalité cible sans ambiguïté (F, B♭, E♭, A♭, D♭ -> bémols ; G, D, A, E, B -> dièses) ; sinon écriture d'origine du morceau ; sinon sens du décalage.
export function spellingFor(keyStr, semis, acc) {
  acc = acc || {};                                                         // null (aucun morceau chargé) accepté
  const k = parseKey(keyStr);
  if (k) {
    const tonic = mod12(k.pc + semis), major = k.minor ? mod12(tonic + 3) : tonic;
    if ([5, 10, 3, 8, 1].includes(major)) return true;
    if ([7, 2, 9, 4, 11].includes(major)) return false;
  }
  if ((acc.flats || 0) !== (acc.sharps || 0)) return (acc.flats || 0) > (acc.sharps || 0);
  return semis < 0;
}
// « Sol majeur » + 2 -> « La majeur » (même langue, même style que l'original).
export function transposeKey(keyStr, semis, flats) {
  const k = parseKey(keyStr);
  if (!k || !semis) return keyStr;
  const pc = mod12(k.pc + semis);
  let name = (k.fr ? (flats ? FR_FLAT : FR_SHARP) : (flats ? FLAT : SHARP))[pc];
  if (k.fr && !k.accent) name = name.replace('é', 'e');
  return glyphs(name, k.uni) + (k.rest ? (k.sep || '') + k.rest : '');
}

// ---------- BPM local ----------
function buildBpm(meta) {
  if (!Array.isArray(meta.bpm_local) || !meta.bpm_local.length) return null;
  const l = meta.bpm_local.filter(b => b && num(b.beat_time) !== null && num(b.bpm) !== null).sort((a, b) => a.beat_time - b.beat_time);
  return l.length ? { t: Float64Array.from(l.map(b => b.beat_time)), bpm: Float64Array.from(l.map(b => b.bpm)) } : null;
}
export function bpmAt(b, t) { const i = lastLE(b.t, t); return i < 0 ? b.bpm[0] : b.bpm[i]; }

// ---------- paroles ----------
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(raw.trim());
    if (m) out.push({ text: m[3].trim(), start: (+m[1]) * 60 + (+m[2]) });
  }
  out.forEach((l, i) => { l.end = i + 1 < out.length ? out[i + 1].start : l.start + 4; l.words = []; });
  return out.filter(l => l.text);
}
function buildLyrics(meta) {
  let lines = null;
  const nf = meta.lyrics_new_format;
  if (Array.isArray(nf) && nf.length) {
    lines = nf.filter(l => l && l.text && num(l.start) !== null).map(l => ({
      text: String(l.text), start: l.start, end: num(l.end) ?? l.start + 3,
      words: Array.isArray(l.words) ? l.words.filter(w => w && w.word && num(w.start) !== null).map(w => ({ word: String(w.word), start: w.start, end: num(w.end) ?? w.start })) : [],
    }));
  } else if (typeof meta.paroles_lrc === 'string') lines = parseLrc(meta.paroles_lrc);
  if (!lines || !lines.length) return null;
  lines.sort((a, b) => a.start - b.start);
  return { lines, starts: Float64Array.from(lines.map(l => l.start)) };
}
// Ligne active (jusqu'à 2,5 s après sa fin, pour ne pas clignoter entre deux phrases) et mot courant.
export function lyricAt(ly, t) {
  const i = lastLE(ly.starts, t);
  if (i < 0) return { line: -1, word: -1 };
  const l = ly.lines[i];
  if (t > l.end + 2.5) return { line: -1, word: -1 };
  let w = -1; for (let k = 0; k < l.words.length; k++) if (l.words[k].start <= t) w = k; else break;
  return { line: i, word: w };
}

// ---------- sections ----------
function buildSections(meta) {
  const src = Array.isArray(meta.segments) ? meta.segments : (meta.infos && Array.isArray(meta.infos.sections)) ? meta.infos.sections : null;
  if (!src) return null;
  const l = src.filter(s => s && num(s.start) !== null && num(s.end) !== null).map(s => ({ label: String(s.label || ''), start: s.start, end: s.end }));
  return l.length ? l.sort((a, b) => a.start - b.start) : null;
}
// Regroupe les sections consécutives de même nom (ex. 3 « Chorus » d'affilée) et numérote les répétitions.
export function mergeSections(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.label.trim().toLowerCase() === s.label.trim().toLowerCase()) last.end = s.end;
    else out.push({ ...s });
  }
  const total = {}, seen = {};
  out.forEach(s => { total[s.label] = (total[s.label] || 0) + 1; });
  out.forEach(s => { seen[s.label] = (seen[s.label] || 0) + 1; s.name = total[s.label] > 1 ? s.label + ' ' + seen[s.label] : s.label; });
  return out;
}
export function sectionsView(segs, merged) { return merged ? mergeSections(segs) : segs.map(s => ({ ...s, name: s.label })); }
export function sectionAt(view, t) { for (let i = 0; i < view.length; i++) if (t >= view[i].start && t < view[i].end) return i; return -1; }
export const shortLabel = n => n.split(/\s+/).map(w => /^\d+$/.test(w) ? w : w[0].toUpperCase()).join('');

// ---------- point d'entrée ----------
export function buildMeta(meta) {
  meta = meta || {};
  return { info: meta.infos || {}, beats: buildBeats(meta), chords: buildChords(meta), bpm: buildBpm(meta), lyrics: buildLyrics(meta), sections: buildSections(meta) };
}
