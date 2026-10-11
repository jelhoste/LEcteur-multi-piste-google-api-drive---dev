// stretch.js : réserve de Workers d'étirement, côté fil principal. Chaque piste est toujours traitée par le même Worker (son état y vit).
export const PRESET_LATENCY = { default: [2880, 2880], cheaper: [2400, 4320] };      // doit rester égal à StretchCore.LATENCY (un test le vérifie)
// Retard (échantillons de sortie) entre entrée et sortie du moteur à la vitesse `rate`.
export const delayOut = (rate, preset = 'default') => { const [i, o] = PRESET_LATENCY[preset] || PRESET_LATENCY.default; return Math.round(o + i / rate); };

export function createPool(makeWorker, count) {
  const workers = [], pending = new Map(); let seq = 0, dead = null;
  const fail = err => { dead = dead || err; for (const p of pending.values()) p.reject(err); pending.clear(); };
  for (let k = 0; k < count; k++) {
    const w = makeWorker();
    w.onmessage = e => {
      const m = e.data, p = pending.get(m.seq); if (!p) return;
      pending.delete(m.seq);
      if (m.t === 'error') p.reject(new Error(m.message)); else p.resolve(m);
    };
    w.onerror = e => fail(new Error('Le moteur d\'étirement a échoué' + (e && e.message ? ' : ' + e.message : '') + '.'));
    workers.push(w);
  }
  const send = (k, msg, transfer) => new Promise((resolve, reject) => {
    if (dead) { reject(dead); return; }
    const id = ++seq; pending.set(id, { resolve, reject });
    workers[k].postMessage({ ...msg, seq: id }, transfer || []);
  });
  const home = id => id % workers.length;
  return {
    count: workers.length,
    // Prépare un nouveau flux pour les pistes `ids` (les autres pistes sont libérées).
    async open(ids, { rate, semis, preroll, preset }) {
      await Promise.all(workers.map((_, k) => send(k, { t: 'open', ids: ids.filter(id => home(id) === k), rate, semis, preroll, preset })));
    },
    // Étire un bloc : n échantillons source (L, R) -> nOut échantillons de sortie (moins la latence encore à écarter). L et R sont cédés au Worker.
    async process(id, L, R, nOut) {
      const m = await send(home(id), { t: 'proc', id, L, R, nOut }, [L.buffer, R.buffer]);
      return { L: m.L, R: m.R, ms: m.ms, worker: home(id) };
    },
    dispose() { const err = new Error('Moteur d\'étirement arrêté.'); dead = dead || err; workers.forEach(w => w.terminate && w.terminate()); fail(err); },
  };
}
