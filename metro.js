// metro.js : métronome et précompte. Calculs purs (sans AudioContext ni DOM), testables seuls.
// La grille `grid` est celle de meta.js : { t: temps en secondes, n: numéro du temps dans la mesure, barStarts: débuts de mesure en secondes }.
import { lastLE, firstGT } from './meta.js';

export const COUNT_TOL = 0.06;                                       // un début de mesure à moins de 60 ms est considéré comme « dessus »

// Début de mesure à utiliser pour partir de `t` (secondes) : le début le plus proche s'il est à moins de COUNT_TOL, sinon celui de la mesure en cours.
// Sans grille de mesures : le temps le plus proche, sinon `t` inchangé.
export function barStartFor(grid, t) {
  if (!grid) return t;
  const arr = grid.barStarts && grid.barStarts.length ? grid.barStarts : grid.t;
  if (!arr || !arr.length) return t;
  const i = lastLE(arr, t), cur = i >= 0 ? arr[i] : arr[0], next = i + 1 < arr.length ? arr[i + 1] : null;
  if (next !== null && next - t < COUNT_TOL) return next;
  if (i < 0) return arr[0];
  return cur;
}

// Précompte avant `tStart` (secondes, début d'une mesure) : `bars` mesures de la mesure où l'on arrive.
// Renvoie { n, interval, count, total, clicks } : n temps par mesure, `interval` secondes (du morceau) entre deux clics,
// `total` = durée du précompte, `clicks` = [{ at, accent }] avec `at` en secondes du morceau depuis le début du précompte (le premier temps de chaque mesure est accentué).
// Ces durées sont en temps du morceau : à diviser par la vitesse pour obtenir des secondes réelles.
export function countInPlan(grid, tStart, bars = 1) {
  if (!grid || !grid.t || !grid.t.length) return null;
  const bs = grid.barStarts && grid.barStarts.length ? grid.barStarts : null;
  let n = 4, barLen = 0;
  if (bs) {
    const bi = Math.max(0, lastLE(bs, tStart + COUNT_TOL)), tb = bs[bi];
    let tn;
    if (bi + 1 < bs.length) tn = bs[bi + 1];
    else if (bi > 0) tn = tb + (tb - bs[bi - 1]);
    else tn = 0;
    if (tn > tb) {
      barLen = tn - tb;
      const k = firstGT(grid.t, tn - 0.001) - firstGT(grid.t, tb - 0.001);
      if (k >= 1) n = Math.min(k, 12);
    }
  }
  if (!(barLen > 0)) {                                               // pas de mesures dans la grille : 4 temps de la durée du temps voisin
    const i = Math.min(Math.max(0, lastLE(grid.t, tStart)), grid.t.length - 2);
    const beat = grid.t.length > 1 ? Math.abs(grid.t[i + 1] - grid.t[i]) : 0.5;
    barLen = (beat > 0 ? beat : 0.5) * n;
  }
  let interval = barLen / n; interval = Math.min(2, Math.max(0.15, interval));
  const count = Math.max(1, Math.min(2, bars | 0)) * n, clicks = [];
  for (let k = 0; k < count; k++) clicks.push({ at: k * interval, accent: k % n === 0 });
  return { n, interval, count, total: count * interval, clicks };
}

// Planificateur de clics du métronome pendant la lecture.
// anchor : { src: position source (échantillons) entendue à l'instant `when` (secondes du contexte audio), rate: vitesse (1 = normale) }.
// loop   : { on, a, b } en échantillons ; end : durée du morceau en échantillons ; SR : fréquence d'échantillonnage.
// next(until) renvoie les clics { when, accent } à jouer jusqu'à l'instant `until` (contexte audio), puis se souvient d'où il en est : chaque clic n'est renvoyé qu'une fois.
export function createClickScheduler(grid, anchor, loop, end, SR = 48000) {
  const t = grid.t, rate = anchor.rate || 1;
  const L = loop && loop.on && loop.b > loop.a ? loop : null;
  let src = anchor.src; if (L && src >= L.b) src = L.a;              // même règle que le moteur : un départ après la fin de la boucle reprend au début
  let virt = 0;                                                      // échantillons « virtuels » écoulés grâce aux tours de boucle déjà faits (b − a par tour)
  let idx = firstGT(t, src / SR - 1e-6 - 1e-9);                      // premier temps à partir de la position de départ (celui qui tombe pile compte)
  const whenOf = bs => anchor.when + (bs - src + virt) / (SR * rate);
  return {
    next(until) {
      const out = [];
      for (let guard = 0; guard < 4000; guard++) {
        if (L) {
          const wrapAt = whenOf(L.b);
          const bs = idx < t.length ? t[idx] * SR : Infinity;
          if (bs >= L.b) {                                          // le prochain temps est après la fin de la boucle : on attend le raccord, puis on repart du début
            if (wrapAt > until) break;
            virt += L.b - L.a; idx = firstGT(t, L.a / SR - 1e-6 - 1e-9);
            continue;                                               // (sans temps dans la boucle, chaque tour avance le temps : la boucle finit par dépasser `until`)
          }
        }
        if (idx >= t.length) break;
        const bs = t[idx] * SR;
        if (!L && bs >= end) break;                                // fin du morceau
        const when = whenOf(bs);
        if (when > until) break;
        out.push({ when, accent: grid.n[idx] === 1 }); idx++;
      }
      return out;
    },
  };
}
