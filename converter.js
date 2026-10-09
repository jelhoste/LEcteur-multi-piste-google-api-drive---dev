// converter.js : interface du convertisseur M4A (AAC) -> Ogg Opus. Le travail lourd se fait dans convert-worker.js.
import { parseOggOpus } from './ogg-opus.js';
import { outputPath, buildZip, checkResults, buildEncoderInfo, buildReport, readZip, isZipName, assembleOutput } from './converter-lib.js';

const $ = id => document.getElementById(id);
const CC = window.ConvertCore, P = CC.PROFILE;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mb = n => (n / 1e6).toFixed(1) + ' Mo';
const appVersion = () => self.APP_VERSION || '?';
let jobs = [], copies = [], origin = null, results = [], failedCount = 0, worker = null, lastCheck = null, tools = null;

// ----- affichage explicite de l'encodeur et des réglages -----
const rows = [
  ['Profil', P.id + ' : ' + P.label],
  ['Encodeur', P.encoder.library + ' ' + P.encoder.version + ' · ' + P.encoder.binding],
  ['Décodage de la source (AAC)', P.decoder.tool + ' · ' + P.decoder.package],
  ['Conteneur', P.container],
  ['Débit', P.bitrate / 1000 + ' kbit/s, VBR ' + (P.vbr ? (P.vbrConstraint ? 'contraint' : 'non contraint') : 'désactivé')],
  ['Complexité', String(P.complexity)], ['Application', P.applicationName],
  ['Fréquence', P.sampleRate + ' Hz'], ['Canaux', P.channels + ' (stéréo)'],
  ['Trame', P.frameMs + ' ms (' + P.frameSamples + ' échantillons)'], ['Pre-skip', P.preSkip + ' échantillons'],
  ['Équivalent ffmpeg de bureau', P.desktopEquivalent],
];
$('profile-table').innerHTML = rows.map(r => '<tr><th scope="row">' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>').join('');

async function loadTools() {
  if (tools) return tools;
  try { tools = await (await fetch('vendor/VERSIONS.json')).json(); } catch (e) { tools = null; }
  return tools;
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
const slug = s => (String(s || '').trim() || 'morceau').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'morceau';

$('dl-encoder-info').onclick = async () => {
  const info = buildEncoderInfo({ profile: P, tools: await loadTools(), appVersion: appVersion() });
  download('encodeur-' + P.id + '.json', JSON.stringify(info, null, 2), 'application/json');
};

// ----- liste des fichiers et progression -----
function renderList(states = []) {
  $('conv-list').innerHTML = jobs.map((f, i) => '<p><strong>' + esc(f.name) + '</strong> → <code>' + esc(f.path) + '</code> · ' + mb(f.size) + ' · ' + esc(states[i] || 'en attente') + '</p>').join('')
    + (copies.length ? '<p class="muted">Repris tels quels (' + copies.length + ') : ' + esc(copies.map(c => c.path).join(', ')) + '</p>' : '');
}
function resetOutput() { results = []; lastCheck = null; failedCount = 0; $('conv-summary').textContent = ''; $('conv-summary').className = ''; $('conv-zip').hidden = true; $('conv-report').hidden = true; }

// Le sélecteur accepte soit le ZIP d'un morceau (JSON + .m4a), soit directement des .m4a.
$('conv-files').onchange = async () => {
  const picked = [...$('conv-files').files];
  jobs = []; copies = []; origin = null; resetOutput(); renderList(); $('conv-run').disabled = true;
  try {
    const zips = picked.filter(f => isZipName(f.name));
    if (zips.length > 1) throw new Error('Choisissez un seul ZIP à la fois (un ZIP = un morceau).');
    if (zips.length) {
      $('conv-summary').textContent = 'Lecture du ZIP…';
      const zb = new Uint8Array(await zips[0].arrayBuffer());
      const entries = await readZip(zb);
      origin = { nom: zips[0].name, octets: zb.length, sha256: await CC.sha256Hex(zb) };
      for (const e of entries) {
        if (/\.m4a$/i.test(e.path)) jobs.push({ name: e.path.replace(/^.*\//, ''), size: e.bytes.length, bytes: e.bytes });
        else copies.push({ path: e.path, bytes: e.bytes, sha256: await CC.sha256Hex(e.bytes) });
      }
      copies = copies.filter(c => c.path !== '_termine');           // un ancien marqueur ne vaut pas pour les nouveaux fichiers
      if (!$('conv-song').value.trim()) {                            // nom du morceau : infos.json, sinon nom du ZIP
        let n = ''; const inf = copies.find(c => c.path === 'infos.json');
        try { const j = JSON.parse(new TextDecoder().decode(inf.bytes)); n = [j.artiste, j.titre].filter(Boolean).join(' - '); } catch (e) {}
        $('conv-song').value = n || zips[0].name.replace(/\.zip$/i, '').replace(/_/g, ' ').trim();
      }
      $('conv-summary').textContent = '';
    }
    for (const f of picked.filter(f => !isZipName(f.name) && /\.m4a$/i.test(f.name))) jobs.push({ name: f.name, size: f.size, file: f });
    jobs.forEach(j => { j.path = outputPath(j.name); });
    jobs.sort((a, b) => a.path.localeCompare(b.path));
    const seen = new Set();
    jobs = jobs.filter(j => { if (seen.has(j.path)) { $('conv-summary').textContent = 'Fichier en double ignoré : ' + j.name; return false; } seen.add(j.path); return true; });
    if (!jobs.length) throw new Error('Aucun fichier .m4a trouvé.');
    renderList(); $('conv-run').disabled = false;
  } catch (e) { jobs = []; copies = []; origin = null; renderList(); $('conv-summary').textContent = '✘ ' + e.message; $('conv-summary').className = 'ko'; }
};

// ----- worker -----
let pending = new Map(), nextId = 0;
function startWorker() {
  worker = new Worker('convert-worker.js');
  return new Promise((resolve, reject) => {
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'ready') resolve();
      else if (m.type === 'fatal') reject(new Error(/fetch|network|load failed/i.test(m.message) ? 'Impossible de charger l\'encodeur : une connexion est nécessaire la première fois (environ 10 Mo).' : m.message));
      else if (pending.has(m.id)) pending.get(m.id)(m);
    };
    worker.onerror = e => reject(new Error('Le module de conversion n\'a pas pu démarrer' + (e.message ? ' : ' + e.message : '') + '.'));
    worker.postMessage({ type: 'init' });
  });
}
function convertOne(file, onProgress) {
  return new Promise(async (resolve, reject) => {
    const bytes = file.bytes ? file.bytes.slice() : new Uint8Array(await file.file.arrayBuffer()), id = ++nextId;   // copie : le tampon est transféré au worker
    pending.set(id, m => {
      if (m.type === 'progress') onProgress(m);
      else { pending.delete(id); if (m.type === 'done') resolve(m); else reject(new Error(m.message)); }
    });
    worker.postMessage({ type: 'convert', id, name: file.name, bytes }, [bytes.buffer]);
  });
}

$('conv-run').onclick = async () => {
  const states = jobs.map(() => 'en attente'); let failed = 0;
  resetOutput(); $('conv-run').disabled = true;
  try {
    $('conv-summary').textContent = 'Démarrage de l\'encodeur…';
    await startWorker();
    $('conv-summary').textContent = '';
    for (let i = 0; i < jobs.length; i++) {
      states[i] = 'en cours…'; renderList(states);
      try {
        const m = await convertOne(jobs[i], p => { states[i] = p.phase === 'decode' ? 'décodage…' : 'encodage ' + Math.round((p.p || 0) * 100) + ' %'; renderList(states); });
        results.push({ name: jobs[i].name, path: jobs[i].path, bytes: m.bytes, stats: m.stats });
        states[i] = '✔ ' + mb(m.bytes.length) + ' en ' + (m.stats.ms / 1000).toFixed(1) + ' s';
      } catch (e) { failed++; states[i] = '✘ ' + e.message; }
      renderList(states);
    }
  } catch (e) { $('conv-summary').textContent = '✘ ' + e.message; $('conv-run').disabled = false; if (worker) worker.terminate(); worker = null; return; }
  failedCount = failed;
  if (worker) worker.terminate(); worker = null;                    // libère la mémoire de FFmpeg
  $('conv-run').disabled = false;
  if (!results.length) { $('conv-summary').textContent = '✘ Aucun fichier converti.'; return; }
  const items = results.map(r => ({ name: r.name, parsed: parseOggOpus(r.bytes) }));   // relecture avec le même analyseur que le lecteur
  lastCheck = checkResults(items, P.id);
  $('conv-summary').textContent = (lastCheck.ok ? '✔ ' + results.length + ' fichier(s) convertis, durées identiques (' + lastCheck.durationSamples + ' échantillons), même profil ' + P.id + '.'
    : '✘ Contrôle : ' + [!lastCheck.durationsEqual && 'durées différentes', !lastCheck.preSkipEqual && 'pre-skip différents', !lastCheck.sameProfile && 'profils différents'].filter(Boolean).join(', ') + '.')
    + (failed ? ' ' + failed + ' fichier(s) en échec.' : '');
  $('conv-summary').className = lastCheck.ok && !failed ? 'ok' : 'ko';
  $('conv-zip').hidden = false; $('conv-report').hidden = false;
};

const termineWanted = () => $('conv-termine').checked && !!lastCheck && lastCheck.ok && failedCount === 0;
async function report() {
  return buildReport({ profile: P, tools: await loadTools(), appVersion: appVersion(), songName: $('conv-song').value, results, check: lastCheck,
    userAgent: navigator.userAgent, origin, copies, termine: termineWanted() });
}
$('conv-report').onclick = async () => download('encodage.json', JSON.stringify(await report(), null, 2), 'application/json');
$('conv-zip').onclick = async () => {
  const reportBytes = new TextEncoder().encode(JSON.stringify(await report(), null, 2));
  const zip = buildZip(assembleOutput({ copies, results, reportBytes, termine: termineWanted() }));
  download(slug($('conv-song').value) + '_opus.zip', zip, 'application/zip');
  if ($('conv-termine').checked && !termineWanted()) $('conv-summary').textContent += ' (_termine non ajouté : le lot n\'est pas entièrement valide.)';
};
