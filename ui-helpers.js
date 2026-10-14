// Aides d'interface sans dépendance au DOM de l'application (testables seules) :
// icônes de pistes, appui long, échelle du tempo en BPM, règles de la boucle, sauts de section.

// ---------- pistes : type d'après le nom du fichier, icône ----------
export const KIND_LABEL = { vocals: 'Voix', drums: 'Batterie', bass: 'Basse', guitar: 'Guitare', keys: 'Clavier', original: 'Mix original', other: 'Autre' };
export function kindOf(name) {
  const n = String(name || '').toLowerCase();
  if (/^original|^mix\b|^full/.test(n)) return 'original';
  if (/voc|voix|chant|vox|lead|sing/.test(n)) return 'vocals';
  if (/drum|batt|perc/.test(n)) return 'drums';
  if (/bass/.test(n)) return 'bass';
  if (/piano|key|clav|synth|orgue|organ/.test(n)) return 'keys';   // avant la guitare : « electric piano » est un clavier
  if (/guit|gtr|electr|élec|elec|acoust|acous|folk/.test(n)) return 'guitar';   // guitare, électrique, acoustique (la basse, testée plus haut, reste une basse)
  return 'other';
}
const PATHS = {
  vocals: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  drums: '<ellipse cx="12" cy="11" rx="8" ry="3"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6M9 6 6.5 3M15 6l2.5-3"/>',
  guitar: '<path d="M9.5 22v-6.2C8.3 14.3 7.9 11 8.2 7.6 8.5 5 10 3 12 3s3.5 2 3.8 4.6c.3 3.4-.1 6.7-1.3 8.2V22"/><path d="M8.1 6.2H6.3M8 9.7H6.3M8.1 13.1H6.3M15.9 6.2h1.8M16 9.7h1.7M15.9 13.1h1.8"/><circle cx="4.9" cy="6.2" r="1.35" fill="currentColor" stroke="none"/><circle cx="4.9" cy="9.7" r="1.35" fill="currentColor" stroke="none"/><circle cx="4.9" cy="13.1" r="1.35" fill="currentColor" stroke="none"/><circle cx="19.1" cy="6.2" r="1.35" fill="currentColor" stroke="none"/><circle cx="19.1" cy="9.7" r="1.35" fill="currentColor" stroke="none"/><circle cx="19.1" cy="13.1" r="1.35" fill="currentColor" stroke="none"/>',
  bass: '<path d="M10 22v-6.4C9.2 14.2 8.9 11 9.2 7.8 9.5 5.2 10.6 3 12 3s2.5 2.2 2.8 4.8c.3 3.2 0 6.4-.8 7.8V22"/><path d="M9.1 7H7.3M9 11.4H7.3M14.9 7h1.8M15 11.4h1.7"/><circle cx="5.9" cy="7" r="1.35" fill="currentColor" stroke="none"/><circle cx="5.9" cy="11.4" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.1" cy="7" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.1" cy="11.4" r="1.35" fill="currentColor" stroke="none"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M7.5 18v-4M12 18v-4M16.5 18v-4M7.5 6v8M12 6v8M16.5 6v8"/>',
  other: '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>',
  original: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  master: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
};
export const iconSvg = kind => '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + (PATHS[kind] || PATHS.other) + '<path class="slash" d="M3.5 3.5l17 17"/></svg>';

// ---------- appui court / appui long ----------
// Un appui court appelle onTap au relâchement ; un appui qui dépasse `ms` appelle onLong tout de suite (retour immédiat) et ne fait plus rien au relâchement.
// Le clavier et les lecteurs d'écran passent par `click` sans détail (equivalent d'un appui court).
export const LONG_MS = 450;
export function pressable(el, onTap, onLong, ms = LONG_MS) {
  let timer = null, down = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  el.onpointerdown = e => { if (e && e.button > 0) return; down = true; clear(); timer = setTimeout(() => { timer = null; onLong(); }, ms); };
  el.onpointerup = () => { if (!down) return; down = false; if (timer) { clear(); onTap(); } };
  el.onpointercancel = el.onpointerleave = () => { down = false; clear(); };
  el.oncontextmenu = e => { if (e && e.preventDefault) e.preventDefault(); return false; };
  el.onclick = e => { if (!e || !e.detail) onTap(); };
}

// ---------- tempo : BPM si le tempo d'origine est connu, sinon pourcentage ----------
// toValue(vitesse) -> valeur affichée ; toSpeed(valeur) -> vitesse (1 exactement à la valeur d'origine) ; bornes : 50 % à 150 %.
export function tempoModel(origBpm, smin = 0.5, smax = 1.5) {
  const o = +origBpm > 0 ? +origBpm : 0;
  if (!o) return { unit: '%', orig: 100, min: Math.round(smin * 100), max: Math.round(smax * 100), toValue: s => Math.round(s * 100), toSpeed: v => v / 100 };
  const r = Math.round(o);
  return { unit: 'BPM', orig: r, min: Math.ceil(o * smin), max: Math.floor(o * smax),
    toValue: s => s === 1 ? r : Math.round(s * o), toSpeed: v => v === r ? 1 : v / o };
}

// ---------- boucle : le début et la fin se règlent à partir des cartes de structure ----------
// Un toucher sur une carte : la boucle devient cette carte. Un appui long : la fin se place à la fin de la carte ;
// si cette fin tombe avant le début actuel, la boucle se réduit à cette carte (jamais de boucle inversée).
export const loopTap = (view, i) => ({ a: view[i].start, b: view[i].end });
export function loopLong(view, cur, j) {
  const b = view[j].end;
  return (cur && b > cur.a + 0.1) ? { a: cur.a, b } : { a: view[j].start, b };
}

// ---------- sauts de section (appui long sur ⏪ / ⏩) ----------
// dir -1 : début de la section en cours (ou de la précédente si l'on est déjà au début) ; dir +1 : fin de la section en cours (début de la suivante).
export function sectionJump(view, t, dir, near = 1.0) {
  if (!view || !view.length) return null;
  let i = -1; for (let k = 0; k < view.length; k++) if (t >= view[k].start && t < view[k].end) { i = k; break; }
  if (dir < 0) {
    if (i < 0) { const p = view.filter(g => g.end <= t); const g = p[p.length - 1]; return g ? { t: g.start, name: g.name } : { t: 0, name: 'Début du morceau' }; }
    if (t - view[i].start >= near || i === 0) return { t: view[i].start, name: view[i].name };
    return { t: view[i - 1].start, name: view[i - 1].name };
  }
  if (i < 0) { const g = view.find(x => x.start > t); return g ? { t: g.start, name: g.name } : null; }
  return i + 1 < view.length ? { t: view[i + 1].start, name: view[i + 1].name } : { t: view[i].end, name: 'Fin du morceau' };
}
