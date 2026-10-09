// converter-lib.js : fonctions pures du convertisseur (chemins de sortie, ZIP, contrôles, rapports). Testées sous Node.

// original.m4a -> original.opus (racine du morceau) ; les autres pistes -> stems/<nom>.opus
export const outputPath = name => /^original\.[^.]+$/i.test(name) ? 'original.opus' : 'stems/' + name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') + '.opus';

const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[i] = c >>> 0; }
export function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

// ZIP sans compression (les fichiers Opus sont déjà compressés). entries : [{path, bytes}]
export function buildZip(entries, date = new Date()) {
  const te = new TextEncoder(), dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = te.encode(e.path), crc = crc32(e.bytes), size = e.bytes.length;
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true); lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); ch.set(name, 46);
    locals.push(lh, e.bytes); centrals.push(ch); offset += lh.length + size;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end], out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Contrôles sur le lot converti. items : [{name, parsed}] où parsed vient de parseOggOpus (relecture des fichiers produits).
export function checkResults(items, profileId) {
  const uniq = f => new Set(items.map(f)).size;
  const durations = uniq(i => i.parsed.durationSamples), preSkips = uniq(i => i.parsed.preSkip);
  const profiles = uniq(i => (i.parsed.tags.comments.PROFILE || '?'));
  const allMine = items.every(i => i.parsed.tags.comments.PROFILE === profileId);
  return { durationsEqual: durations === 1, preSkipEqual: preSkips === 1, sameProfile: profiles === 1 && allMine,
    durationSamples: durations === 1 ? items[0].parsed.durationSamples : null, ok: durations === 1 && preSkips === 1 && profiles === 1 && allMine };
}

export function buildEncoderInfo({ profile, tools, appVersion, now = new Date() }) {
  return {
    document: 'Encodeur et réglages de conversion M4A (AAC) vers Ogg Opus',
    genere: now.toISOString(),
    application: { nom: 'Lecteur multipistes', version: appVersion },
    profil: profile,
    composants: tools || null,
    reproduire: {
      dansCetteApplication: 'Convertisseur M4A > Opus : même profil, mêmes composants embarqués, résultat identique octet pour octet.',
      avecFfmpegDeBureau: profile.desktopEquivalent,
      remarque: 'Un ffmpeg de bureau donne un audio équivalent (même durée, même pre-skip) mais pas des octets identiques. Ne pas mélanger les deux dans un même morceau.',
    },
    pourFaireEvoluer: 'Ne jamais modifier un profil existant : créer un nouveau profil (nouvel id, ex. opus-96-v2) dans convert-core.js, puis reconvertir le morceau entier. Les fichiers portent l\'étiquette PROFILE ; le lecteur signale les mélanges.',
  };
}

export function buildReport({ profile, tools, appVersion, songName, results, check, userAgent, origin = null, copies = [], termine = false, now = new Date() }) {
  return {
    ...buildEncoderInfo({ profile, tools, appVersion, now }),
    document: 'Rapport de conversion M4A (AAC) vers Ogg Opus',
    morceau: songName || null,
    origine: origin,
    fichiersRepris: copies.map(c => ({ chemin: c.path, octets: c.bytes.length, sha256: c.sha256 || null })),
    marqueurTermine: termine,
    navigateur: userAgent || null,
    controles: check,
    fichiers: results.map(r => ({
      source: { nom: r.name, octets: r.stats.inputSize, sha256: r.stats.sourceSha256, duree: r.stats.source.duration, flux: r.stats.source.stream },
      sortie: { chemin: r.path, octets: r.stats.outputSize, sha256: r.stats.outputSha256, echantillons48k: r.stats.samples, secondes: +r.stats.seconds.toFixed(3), paquets: r.stats.packets },
      dureeConversionMs: r.stats.ms,
    })),
  };
}

// ---------- lecture d'un ZIP (méthodes « stockée » et « deflate », sans ZIP64 ni chiffrement) ----------
export const isZipName = n => /\.zip$/i.test(n);

export function normalizeZipEntries(list) {
  let l = list.map(e => ({ ...e, path: e.path.replace(/\\/g, '/') }))
    .filter(e => !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(e.path) && !/(^|\/)\._/.test(e.path));
  for (const e of l) if (e.path.startsWith('/') || e.path.split('/').includes('..')) throw new Error('Chemin dangereux dans le ZIP : ' + e.path);
  // Un dossier racine unique (ex. « Artiste - Titre/… ») est retiré, sauf s'il s'agit de stems/ lui-même.
  const firsts = new Set(l.map(e => e.path.split('/')[0]));
  if (l.length && firsts.size === 1 && l.every(e => e.path.includes('/')) && [...firsts][0].toLowerCase() !== 'stems') l = l.map(e => ({ ...e, path: e.path.slice(e.path.indexOf('/') + 1) }));
  return l;
}

export async function readZip(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Ce navigateur ne sait pas ouvrir un ZIP compressé : extrayez les fichiers, puis choisissez les .m4a.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Ce fichier n\'est pas un ZIP valide (fin de répertoire introuvable).');
  const count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xFFFF || cdOff === 0xFFFFFFFF) throw new Error('ZIP64 non pris en charge.');
  const td = new TextDecoder('utf-8'), entries = []; let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP corrompu (répertoire central).');
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    entries.push({ flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true), crc: dv.getUint32(p + 16, true), csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true), off: dv.getUint32(p + 42, true), name: td.decode(bytes.subarray(p + 46, p + 46 + nl)) });
    p += 46 + nl + el + cl;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;                                   // dossier
    if (e.flags & 1) throw new Error(e.name + ' : ZIP chiffré, non pris en charge.');
    if (e.csize === 0xFFFFFFFF || e.usize === 0xFFFFFFFF || e.off === 0xFFFFFFFF) throw new Error('ZIP64 non pris en charge.');
    if (e.off + 30 > bytes.length || dv.getUint32(e.off, true) !== 0x04034b50) throw new Error(e.name + ' : ZIP corrompu (en-tête local).');
    const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true), raw = bytes.subarray(start, start + e.csize);
    let data;
    if (e.method === 0) data = raw.slice();
    else if (e.method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error(e.name + ' : méthode de compression ' + e.method + ' non prise en charge.');
    if (data.length !== e.usize) throw new Error(e.name + ' : taille incorrecte (ZIP corrompu).');
    if (crc32(data) !== e.crc) throw new Error(e.name + ' : somme de contrôle incorrecte (ZIP corrompu).');
    out.push({ path: e.name, bytes: data });
  }
  return normalizeZipEntries(out);
}

// Assemble le contenu du ZIP de sortie : fichiers repris tels quels, puis fichiers convertis, rapport, marqueur. Les derniers l'emportent sur un même chemin.
export function assembleOutput({ copies, results, reportBytes, termine }) {
  const map = new Map();
  for (const c of copies) if (c.path !== '_termine' && c.path !== 'encodage.json') map.set(c.path, c.bytes);   // un ancien _termine ne décrivait pas ces fichiers
  for (const r of results) map.set(r.path, r.bytes);
  map.set('encodage.json', reportBytes);
  if (termine) map.set('_termine', new TextEncoder().encode('complet'));
  return [...map].map(([path, bytes]) => ({ path, bytes }));
}
