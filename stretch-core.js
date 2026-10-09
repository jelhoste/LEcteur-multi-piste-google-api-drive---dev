// stretch-core.js : cœur du time stretch (changement de vitesse sans changer la hauteur) et de la transposition.
// Un moteur = une instance WebAssembly de Signalsmith Stretch = UNE piste stéréo. Les états ne se mélangent donc jamais.
// Utilisé par stretch-worker.js (dans un Worker) et par les tests. Aucune dépendance au navigateur.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.StretchCore = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SR = 48000;
  const CHUNK = 2048;                                              // échantillons de sortie par appel (entrée <= 4096 jusqu'à 200 %, sous la taille du tampon interne)
  const TONALITY_HZ = 8000;                                        // valeur par défaut de la bibliothèque
  // Latences du moteur mesurées sur la bibliothèque 1.3.2 (échantillons à 48 kHz) : [entrée, sortie]. Vérifiées au démarrage de chaque moteur.
  const LATENCY = Object.freeze({ default: [2880, 2880], cheaper: [2400, 4320] });
  // Retard (en échantillons de SORTIE) entre l'entrée et la sortie à la vitesse `rate` : sortie + entrée / vitesse. Mesuré : 5760 à 100 %, 6455 à 80 %.
  const delayOut = (rate, preset = 'default') => { const [i, o] = LATENCY[preset] || LATENCY.default; return Math.round(o + i / rate); };

  async function createEngine(factory, preset = 'default') {
    if (!LATENCY[preset]) throw new Error('Qualité d\'étirement inconnue : ' + preset);
    const M = await factory(); M._main();
    if (preset === 'cheaper') M._presetCheaper(2, SR); else M._presetDefault(2, SR);
    const inLat = M._inputLatency(), outLat = M._outputLatency();
    if (inLat !== LATENCY[preset][0] || outLat !== LATENCY[preset][1]) throw new Error('Latence inattendue du moteur d\'étirement (' + inLat + '/' + outLat + ') : bibliothèque modifiée ?');
    const cap = inLat + outLat, ptr = M._setBuffers(2, cap), lb = cap * 4;
    let discardLeft = 0;
    return {
      preset, cap,
      // Démarre un nouveau flux. `preroll` : nombre d'échantillons d'entrée fournis AVANT la position voulue (pour chauffer le moteur) ; ils sont écartés de la sortie.
      begin(rate, semitones, preroll = 0) {
        M._reset(); M._setTransposeSemitones(semitones, TONALITY_HZ / SR); M._setFormantSemitones(0, false); M._setFormantBase(0);
        discardLeft = delayOut(rate, preset) + Math.round(preroll / rate);
        return discardLeft;
      },
      // Fait passer `inL/inR` (n échantillons source) et produit `nOut` échantillons de sortie, moins ceux qu'il reste à écarter (latence). Le rapport entrée/sortie fixe la vitesse.
      run(inL, inR, nOut) {
        const nIn = inL.length;
        if (inR.length !== nIn) throw new Error('Canaux de longueurs différentes');
        const drop = Math.min(discardLeft, nOut), keep = nOut - drop;
        const L = new Float32Array(keep), R = new Float32Array(keep);
        const ratio = nOut > 0 ? nIn / nOut : 0;
        let o = 0, i = 0, w = 0;
        while (o < nOut) {
          let n = Math.min(CHUNK, nOut - o), ni = (o + n >= nOut) ? nIn - i : Math.round((o + n) * ratio) - i;
          while (ni > cap && n > 1) { n = Math.max(1, n >> 1); ni = Math.round((o + n) * ratio) - i; }
          if (ni > cap) throw new Error('Rapport d\'étirement hors limites');
          let heap = M.HEAP8.buffer;
          if (ni > 0) { new Float32Array(heap, ptr, ni).set(inL.subarray(i, i + ni)); new Float32Array(heap, ptr + lb, ni).set(inR.subarray(i, i + ni)); }
          M._process(ni, n);
          heap = M.HEAP8.buffer;                                  // le tampon peut changer si la mémoire grandit : on le relit
          const skip = Math.max(0, Math.min(n, drop - o));         // début de ce morceau de sortie à écarter (latence)
          if (n > skip) {
            L.set(new Float32Array(heap, ptr + lb * 2 + skip * 4, n - skip), w);
            R.set(new Float32Array(heap, ptr + lb * 3 + skip * 4, n - skip), w);
            w += n - skip;
          }
          o += n; i += ni;
        }
        discardLeft -= drop;
        return { L, R };
      },
    };
  }

  // Gestionnaire de messages d'un Worker. `post(message, transferList)` envoie une réponse.
  //   { t:'open', seq, ids:[...], rate, semis, preroll, preset }  -> { t:'opened', seq }
  //   { t:'proc', seq, id, L, R, nOut }                           -> { t:'done', seq, id, L, R, ms }
  function createHandler(factory, post, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    const engines = new Map();
    return async function handle(m) {
      try {
        if (m.t === 'open') {
          for (const id of m.ids) {
            let e = engines.get(id);
            if (!e || e.preset !== m.preset) { e = await createEngine(factory, m.preset); engines.set(id, e); }
            e.begin(m.rate, m.semis, m.preroll);
          }
          for (const id of [...engines.keys()]) if (!m.ids.includes(id)) engines.delete(id);   // pistes devenues inutiles : mémoire libérée
          post({ t: 'opened', seq: m.seq });
        } else if (m.t === 'proc') {
          const e = engines.get(m.id); if (!e) throw new Error('Piste ' + m.id + ' non ouverte');
          const t0 = now(), r = e.run(m.L, m.R, m.nOut);
          post({ t: 'done', seq: m.seq, id: m.id, L: r.L, R: r.R, ms: now() - t0 }, [r.L.buffer, r.R.buffer]);
        } else throw new Error('Message inconnu : ' + m.t);
      } catch (err) { post({ t: 'error', seq: m.seq, message: String(err && err.message || err) }); }
    };
  }

  return { SR, CHUNK, LATENCY, delayOut, createEngine, createHandler };
});
