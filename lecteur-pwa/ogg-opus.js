// ogg-opus.js : parse un fichier Ogg Opus entièrement en mémoire,
// construit un index de paquets (position en échantillons à 48 kHz)
// et décode une plage à partir de n'importe quelle position.
// Fonctionne dans le navigateur (Worker compris) et dans Node.

const TAG = (b, p, s) => { for (let i = 0; i < s.length; i++) if (b[p + i] !== s.charCodeAt(i)) return false; return true; };

// Durée d'un paquet Opus en échantillons à 48 kHz, lue dans l'octet TOC.
export function packetSamples(p) {
  const toc = p[0];
  const config = toc >> 3;
  let frame;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3];       // SILK / hybride
  else if (config < 16) frame = (config & 1) ? 960 : 480;           // hybride
  else frame = [120, 240, 480, 960][config & 3];                    // CELT
  const c = toc & 3;
  const n = c === 0 ? 1 : c === 3 ? (p[1] & 0x3f) : 2;
  return frame * n;
}

// Étiquettes OpusTags : fabricant de l'encodeur + commentaires CLE=valeur (clés en majuscules). Ne lève jamais d'erreur.
function parseTags(d) {
  const out = { vendor: '', comments: {} };
  try {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), td = new TextDecoder();
    let p = 8; const vl = dv.getUint32(p, true); p += 4; out.vendor = td.decode(d.subarray(p, p + vl)); p += vl;
    const n = dv.getUint32(p, true); p += 4;
    for (let i = 0; i < n && p + 4 <= d.length; i++) {
      const l = dv.getUint32(p, true); p += 4; const s = td.decode(d.subarray(p, p + l)); p += l;
      const k = s.indexOf('='); if (k > 0) out.comments[s.slice(0, k).toUpperCase()] = s.slice(k + 1);
    }
  } catch (e) {}
  return out;
}

// bytes : Uint8Array du fichier .opus complet.
export function parseOggOpus(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets = [];          // paquets audio : { start, dur, data }
  let head = null, tags = { vendor: '', comments: {} }, partial = null, pos = 0, pageCount = 0, lastGranule = -1, pktIndex = 0, cursor = 0;

  const pushPacket = (data) => {
    if (pktIndex === 0) {
      if (!TAG(data, 0, 'OpusHead')) throw new Error('OpusHead introuvable : ce n\'est pas un Ogg Opus');
      head = {
        channels: data[9],
        preSkip: data[10] | (data[11] << 8),
        inputRate: (data[12] | (data[13] << 8) | (data[14] << 16) | (data[15] << 24)) >>> 0,
        mappingFamily: data[18],
      };
    } else if (pktIndex === 1) {
      if (!TAG(data, 0, 'OpusTags')) throw new Error('OpusTags introuvable');
      tags = parseTags(data);
    } else {
      const dur = packetSamples(data);
      packets.push({ start: cursor, dur, data });
      cursor += dur;
    }
    pktIndex++;
  };

  while (pos + 27 <= bytes.length) {
    if (!TAG(bytes, pos, 'OggS')) throw new Error('Signature OggS attendue à l\'octet ' + pos);
    const flags = bytes[pos + 5];
    const granule = Number(dv.getBigInt64(pos + 6, true));
    const nseg = bytes[pos + 26];
    let dataPos = pos + 27 + nseg;
    if (dataPos > bytes.length) break;                               // fichier tronqué
    if (granule >= 0) lastGranule = granule;
    if (!(flags & 1)) partial = null;                                // page non « continuée »
    let start = dataPos, len = 0, total = 0;
    for (let i = 0; i < nseg; i++) {
      const lace = bytes[pos + 27 + i];
      len += lace; total += lace;
      if (lace < 255) {                                              // fin de paquet
        let data = bytes.subarray(start, start + len);
        if (partial) { data = concat(partial, data); partial = null; }
        pushPacket(data);
        start += len; len = 0;
      }
    }
    if (len > 0) {                                                   // paquet qui continue sur la page suivante
      (partial = partial || []).push(bytes.subarray(start, start + len));
    }
    pos = dataPos + total;
    pageCount++;
  }
  if (!head) throw new Error('Aucun en-tête Opus');
  return {
    ...head, tags, packets, pageCount,
    totalSamples: cursor,                                            // somme des durées de paquets (incl. pre-skip)
    durationSamples: lastGranule - head.preSkip,                     // durée réelle de la piste, à comparer entre pistes
  };
}

function concat(parts, last) {
  const list = [...parts, last];
  const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of list) { out.set(p, o); o += p.length; }
  return out;
}

// Plus grand indice i tel que packets[i].start <= target.
function findPacket(packets, target) {
  let lo = 0, hi = packets.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (packets[mid].start <= target) lo = mid; else hi = mid - 1; }
  return lo;
}

// Amorce par défaut : 24000 échantillons (0,5 s), validée par test : écart ~2e-8 vs décodage continu (80 ms laissait ~1e-3).
// Décode `numSamples` échantillons à partir de `startSample` (temps audio, pre-skip déjà retiré).
// decoder : instance d'OpusDecoder (opus-decoder) ou OpusDecoderWebWorker (dans ce cas, await sur chaque appel).
// Retourne { channelData: [Float32Array, ...], length } (complété de silence si on dépasse la fin).
export async function decodeRange(parsed, decoder, startSample, numSamples, { preroll = 24000 } = {}) {
  const { packets, preSkip, channels } = parsed;
  const streamPos = startSample + preSkip;
  const first = findPacket(packets, Math.max(0, streamPos - preroll));
  const out = Array.from({ length: channels }, () => new Float32Array(numSamples));
  await decoder.reset();
  let pos = packets[first].start;
  for (let i = first; i < packets.length && pos < streamPos + numSamples; i++) {
    const res = await decoder.decodeFrame(packets[i].data);
    const n = res.samplesDecoded;
    // intersection [pos, pos+n) avec [streamPos, streamPos+numSamples)
    const a = Math.max(pos, streamPos), b = Math.min(pos + n, streamPos + numSamples);
    if (b > a) for (let c = 0; c < channels; c++) {
      out[c].set(res.channelData[Math.min(c, res.channelData.length - 1)].subarray(a - pos, b - pos), a - streamPos);
    }
    pos += n;
  }
  return { channelData: out, length: numSamples };
}
