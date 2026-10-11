// drive.js : chargement d'un morceau depuis Google Drive (API v3 + clé API) et cache IndexedDB.
// Arborescence attendue : racine/ <Artiste - Titre>/ { *.json, paroles.lrc, original.opus, _termine, stems/*.opus }

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanId = id => String(id).replace(/[^\w-]/g, '');
// Accepte un identifiant nu ou une adresse Drive complète (…/folders/ID?usp=sharing, …open?id=ID).
export function parseFolderId(input) {
  const t = String(input || '').trim();
  const m = /\/folders\/([\w-]+)/.exec(t) || /[?&]id=([\w-]+)/.exec(t);
  return m ? m[1] : t.replace(/[^\w-]/g, '');
}

function explain(status, reason) {
  if (reason === 'downloadQuotaExceeded') return 'Quota de téléchargement Drive dépassé pour ce fichier (blocage temporaire, environ 24 h).';
  if (status === 404) return 'Fichier ou dossier introuvable (ou non partagé par lien).';
  if (status === 403) return 'Accès refusé (403' + (reason ? ' : ' + reason : '') + ') : vérifiez la clé API et le partage du dossier.';
  if (status === 400) return 'Requête invalide (400) : clé API ou identifiant incorrect ?';
  return 'Erreur Drive ' + status + (reason ? ' : ' + reason : '');
}

export function createDrive(apiKey) {
  const mediaUrl = id => `${API}/${cleanId(id)}?alt=media&key=${apiKey}`;

  async function request(url, tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
      let res;
      try { res = await fetch(url); }
      catch (e) { throw new Error('Réseau indisponible : impossible de joindre Google Drive.'); }
      if (res.ok) return res;
      let reason = '', detail = '';
      try { const j = await res.clone().json(); reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || ''; detail = (j.error && j.error.message) || ''; } catch (e) {}
      last = new Error(explain(res.status, reason) + (detail ? ' [Google : ' + detail + ']' : ''));
      const retry = res.status === 429 || res.status >= 500 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
      if (!retry) throw last;
      await sleep(500 * 2 ** i + Math.random() * 250);          // backoff exponentiel
    }
    throw last;
  }

  async function list(q) {
    const out = []; let token = '';
    do {
      const url = `${API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,parents)')}&pageSize=1000&orderBy=name&key=${apiKey}` + (token ? `&pageToken=${encodeURIComponent(token)}` : '');
      const j = await (await request(url)).json();
      out.push(...(j.files || [])); token = j.nextPageToken || '';
    } while (token);
    return out;
  }
  const children = id => list(`'${cleanId(id)}' in parents and trashed = false`);

  return {
    // Sous-dossiers de la racine qui contiennent un fichier _termine.
    // Une requête simple par dossier : avec une clé API, Drive refuse (403) les requêtes qui combinent plusieurs dossiers parents avec « or ».
    async listSongs(rootId) {
      const folders = (await children(rootId)).filter(f => f.mimeType === FOLDER), errors = [];
      const ready = await pool(folders, 4, async f => {
        try { return (await children(f.id)).some(x => x.name === '_termine' && x.mimeType !== FOLDER); }
        catch (e) { errors.push(e); return false; }              // un dossier illisible ne bloque pas les autres
      });
      if (folders.length && errors.length === folders.length) throw errors[0];
      return folders.filter((f, i) => ready[i]);
    },
    // { files: {nom: meta} à la racine du morceau, stems: {nom: meta} dans stems/ }
    async openSong(songId) {
      const files = {}; let stemsFolder = null;
      for (const f of await children(songId)) {
        if (f.mimeType === FOLDER) { if (f.name === 'stems') stemsFolder = f; } else files[f.name] = f;
      }
      const stems = {};
      if (stemsFolder) for (const f of await children(stemsFolder.id)) if (f.mimeType !== FOLDER) stems[f.name] = f;
      return { files, stems };
    },
    async getText(meta) { return (await request(mediaUrl(meta.id))).text(); },
    async getBytes(meta, onProgress) {
      const res = await request(mediaUrl(meta.id));
      const total = Number(meta.size) || 0;
      const chunks = []; let got = 0;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); got += value.length; if (onProgress) onProgress(got, total);
        }
      } else { const b = new Uint8Array(await res.arrayBuffer()); chunks.push(b); got = b.length; }
      if (total && got !== total) throw new Error(`${meta.name} : téléchargement incomplet (${got}/${total} octets)`);
      const out = new Uint8Array(got); let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}

// ---------- Cache IndexedDB : Blob par fichier + métadonnées (md5, lastUsed) ----------
export function createCache({ dbName = 'lecteur-cache', maxAgeMs = 45 * 86400e3 } = {}) {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 2);
    r.onupgradeneeded = () => { for (const n of ['files', 'meta', 'songs']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = (names, mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction(names, mode); let r;
    try { r = fn(...names.map(n => t.objectStore(n))); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(r && 'result' in r ? r.result : r);
    t.onerror = t.onabort = () => rej(t.error || new Error('transaction annulée'));
  }));
  const same = (rec, m) => (rec.md5 && m.md5) ? rec.md5 === m.md5 : (rec.modifiedTime === m.modifiedTime && String(rec.size) === String(m.size));

  async function evictOldest() {
    const metas = await run(['meta'], 'readonly', m => m.getAll());
    const keys = await run(['meta'], 'readonly', m => m.getAllKeys());
    const order = keys.map((k, i) => ({ k, t: metas[i].lastUsed || 0 })).sort((a, b) => a.t - b.t);
    const drop = order.slice(0, Math.max(1, Math.ceil(order.length / 4)));
    await run(['files', 'meta'], 'readwrite', (f, m) => { drop.forEach(d => { f.delete(d.k); m.delete(d.k); }); });
  }

  return {
    // Retourne un Uint8Array si la copie en cache est à jour, sinon null. Ne lève jamais d'erreur.
    async get(meta) {
      try {
        const rec = await run(['meta'], 'readonly', m => m.get(meta.id));
        if (!rec || !same(rec, meta)) return null;
        const blob = await run(['files'], 'readonly', f => f.get(meta.id));
        if (!blob) return null;
        rec.lastUsed = Date.now();
        await run(['meta'], 'readwrite', m => m.put(rec, meta.id));
        return new Uint8Array(await blob.arrayBuffer());
      } catch (e) { return null; }
    },
    async put(meta, bytes) {
      const rec = { name: meta.name, md5: meta.md5Checksum || meta.md5 || null, modifiedTime: meta.modifiedTime, size: meta.size, songId: meta.songId || null, lastUsed: Date.now() };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await run(['files', 'meta'], 'readwrite', (f, m) => { f.put(new Blob([bytes]), meta.id); return m.put(rec, meta.id); });
          return true;
        } catch (e) {
          if (attempt === 0 && e && e.name === 'QuotaExceededError') { try { await evictOldest(); } catch (e2) { return false; } }
          else return false;
        }
      }
      return false;
    },
    // Supprime ce qui n'a pas servi depuis maxAgeMs. Retourne le nombre d'entrées supprimées.
    async purge(age = maxAgeMs) {
      try {
        const metas = await run(['meta'], 'readonly', m => m.getAll());
        const keys = await run(['meta'], 'readonly', m => m.getAllKeys());
        const old = keys.filter((k, i) => Date.now() - (metas[i].lastUsed || 0) > age);
        if (old.length) await run(['files', 'meta'], 'readwrite', (f, m) => { old.forEach(k => { f.delete(k); m.delete(k); }); });
        // fiches de morceaux : on garde celles dont au moins une piste reste en cache
        const left = new Set(); (await run(['meta'], 'readonly', m => m.getAll())).forEach(r => left.add(r.songId));
        const sk = await run(['songs'], 'readonly', x => x.getAllKeys());
        const dead = sk.filter(k => !left.has(k));
        if (dead.length) await run(['songs'], 'readwrite', x => { dead.forEach(k => x.delete(k)); });
        return old.length;
      } catch (e) { return 0; }
    },
    async clear() { try { await run(['files', 'meta', 'songs'], 'readwrite', (f, m, s) => { f.clear(); m.clear(); s.clear(); }); } catch (e) {} },
    // Fiche d'un morceau (listing Drive + JSON) pour pouvoir le rouvrir sans connexion.
    async putSong(id, rec) { try { await run(['songs'], 'readwrite', s => s.put(rec, id)); return true; } catch (e) { return false; } },
    async getSong(id) { try { return (await run(['songs'], 'readonly', s => s.get(id))) || null; } catch (e) { return null; } },
    async listSongs() {
      try {
        const keys = await run(['songs'], 'readonly', s => s.getAllKeys()), vals = await run(['songs'], 'readonly', s => s.getAll());
        return keys.map((id, i) => ({ id, name: vals[i].name || id, savedAt: vals[i].savedAt || 0 })).sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { return []; }
    },
    async usage() { try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch (e) { return null; } },
    async persist() { try { return !!(navigator.storage && navigator.storage.persist && await navigator.storage.persist()); } catch (e) { return false; } },
  };
}

// ---------- Chargement complet d'un morceau ----------
async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// Retourne { meta, tracks: [{name, bytes}], warnings, fromCache, offline }.
// drive peut être null (hors ligne) : le morceau est alors reconstruit depuis la fiche enregistrée.
export async function loadSong(drive, cache, songFolderId, onStatus = () => {}, songName = '') {
  let files, stems, meta = {}, offline = false; const warnings = [];
  try {
    if (!drive) throw new Error('Ce morceau n\'est pas disponible hors ligne (il n\'a jamais été ouvert avec une connexion).');
    ({ files, stems } = await drive.openSong(songFolderId));
    await Promise.all(Object.values(files).filter(f => /\.json$/i.test(f.name)).map(async f => {
      const key = f.name.replace(/\.json$/i, '');
      try { meta[key] = JSON.parse(await drive.getText(f)); }
      catch (e) { meta[key] = null; warnings.push(f.name + ' illisible : ' + e.message); }
    }));
    if (files['paroles.lrc']) { try { meta.paroles_lrc = await drive.getText(files['paroles.lrc']); } catch (e) { warnings.push('paroles.lrc illisible : ' + e.message); } }
    if (cache) await cache.putSong(songFolderId, { name: songName, files, stems, meta, savedAt: Date.now() });
  } catch (e) {
    const rec = cache ? await cache.getSong(songFolderId) : null;
    if (!rec) throw e;
    ({ files, stems, meta } = rec); offline = true; onStatus('Drive injoignable : utilisation de la copie enregistrée sur cet appareil.');
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const opus = Object.values(stems).filter(f => /\.opus$/i.test(f.name)).sort(byName);
  if (files['original.opus']) opus.push(files['original.opus']);
  if (!opus.length) throw new Error('Aucun fichier .opus trouvé dans stems/ (les .m4a ne sont pas utilisés par le lecteur).');
  opus.forEach(f => { f.songId = songFolderId; });
  const total = opus.reduce((s, f) => s + (Number(f.size) || 0), 0), got = new Map(); let hits = 0;
  const report = () => { let g = 0; got.forEach(v => g += v); onStatus(`Chargement des pistes : ${(g / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} Mo` + (hits ? ` (${hits} depuis le cache)` : '')); };
  const bytes = await pool(opus, 3, async f => {
    const c = cache ? await cache.get(f) : null;
    if (c) { hits++; got.set(f.id, c.length); report(); return c; }
    if (!drive) throw new Error(f.name + ' : piste non téléchargée sur cet appareil, une connexion est nécessaire.');
    const b = await drive.getBytes(f, g => { got.set(f.id, g); report(); });
    got.set(f.id, b.length); report();
    if (cache) await cache.put(f, b);
    return b;
  });
  return { meta, warnings, fromCache: hits, offline, tracks: opus.map((f, i) => ({ name: f.name, bytes: bytes[i] })) };
}
