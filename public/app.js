import { StudioClient, StudioAuthError } from './studio-client.js?v=persistent-access-1';
const $ = id => document.getElementById(id);
const stageIds = ['story', 'images', 'videos', 'assembly', 'subtitles', 'music', 'split', 'done'];
const stageLabels = ['Histoire', 'Images', 'Vidéos', 'Assemblage', 'Sous-titres', 'Musique', 'Trois parties', 'Livraison prête'];
const statusLabels = { queued: 'En attente', running: 'En cours', complete: 'Terminé', failed: 'Interrompu' };
let config, local = false, token = '', dashboard = { music: [], stories: [], jobs: [], library: [], imports: [] };
let shared = false, studioClient;
let timer, busy = false, refreshing = false, playerURL, selectedMusic = '', pendingImport, activeTab = 'library';
const getStored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
let pending = getStored('workflowai-pending', []).filter(job => Date.now() - Date.parse(job.createdAt) < 86400000);
pendingImport = getStored('workflowai-import', null);
let remoteRuns = [], runsUpdatedAt = 0;
const recentImports = new Map();
const downloaded = getStored('workflowai-downloads', {});
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const notice = text => { $('global-message').textContent = text; };
const connected = () => shared ? Boolean(studioClient?.connected) : local || Boolean(token);
const repo = () => `https://api.github.com/repos/${config.owner}/${config.repository}`;
const dataRef = () => encodeURIComponent(config.dataRef || 'studio-data');
const date = value => new Intl.DateTimeFormat('fr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const duration = seconds => { const total = Math.round(seconds); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };
async function request(url, options = {}, binary = false) {
  const backendRequest = shared && url.startsWith('/');
  if (backendRequest) {
    try {
      const result = await studioClient.request(url, options);
      if (studioClient.base) config.apiBase = studioClient.base;
      return result;
    } catch (error) {
      if (error instanceof StudioAuthError) $('auth').hidden = false;
      throw error;
    }
  }
  const authorized = url.startsWith('https://api.github.com/');
  const response = await fetch(url, { ...options, cache: 'no-store', referrerPolicy: 'no-referrer', headers: {
    ...(authorized ? { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } : {}),
    ...options.headers,
  } });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error(shared ? 'Accès refusé au studio.' : 'Connexion refusée : vérifie le token et les permissions Actions / Contents du dépôt workFlowAI.');
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || (response.status === 404 ? 'Fichier privé introuvable. Vérifie ton accès au dépôt workFlowAI.' : `Erreur ${response.status}. Réessaie dans un instant.`));
  }
  return binary ? response : response.status === 204 ? null : response.json();
}
function tab(name) {
  activeTab = name;
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('active', button.dataset.tab === name); button.setAttribute('aria-current', button.dataset.tab === name ? 'page' : 'false'); });
  for (const view of ['library', 'create', 'activity']) $(`view-${view}`).hidden = view !== name;
}
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => tab(button.dataset.tab));
for (const button of document.querySelectorAll('[data-go]')) button.addEventListener('click', () => tab(button.dataset.go));
$('open-auth').addEventListener('click', () => { $('auth').hidden = !$('auth').hidden; if (!$('auth').hidden) $('token').focus(); });
$('logout').addEventListener('click', async () => {
  try { await studioClient.logout(); }
  catch { notice('L’accès a été oublié sur cet appareil. Le serveur était injoignable.'); }
  dashboard = { music: [], stories: [], jobs: [], library: [], imports: [] };
  $('auth').hidden = false; render();
});
function updateForm() {
  const mode = $('mode').value;
  $('story-field').hidden = mode === 'generate'; $('story').required = mode !== 'generate';
  $('budget-field').hidden = ['finish', 'check'].includes(mode);
  $('generate').textContent = ({ generate: 'Générer mon histoire ↗', resume: 'Reprendre le traitement ↗', finish: 'Préparer mes trois parties ↗', check: 'Vérifier sans générer ↗' })[mode];
  const active = dashboard.jobs.some(job => ['queued', 'running'].includes(job.status));
  $('generate').disabled = !connected() || busy || active;
  $('import-button').disabled = !connected() || busy;
  if (active) $('form-message').textContent = 'Un traitement est en cours. Retrouve son avancement dans Suivi.';
  else if ($('form-message').textContent.startsWith('Un traitement')) $('form-message').textContent = '';
}
$('mode').addEventListener('change', updateForm);
$('volume').addEventListener('input', () => { $('volume-value').textContent = `${$('volume').value} %`; });
function fillChoices() {
  const story = $('story').value, music = selectedMusic || $('music').value;
  $('story').replaceChildren(element('option', 'Choisir une histoire…')); $('story').firstChild.value = '';
  for (const item of dashboard.stories) { const option = element('option', `${item.title} · ${item.id.slice(6, 16)}`); option.value = item.id; $('story').append(option); }
  if (dashboard.stories.some(item => item.id === story)) $('story').value = story;
  $('music').replaceChildren(element('option', 'Sans musique — dialogues seuls')); $('music').firstChild.value = '';
  for (const name of dashboard.music) { const option = element('option', name); option.value = name; $('music').append(option); }
  if (dashboard.music.includes(music)) { $('music').value = music; selectedMusic = ''; }
}
function fileMeta(file) { return `${file.scenes ? `${file.scenes} scènes · ` : ''}${duration(file.duration)} · ${Math.round(file.bytes / 1048576)} Mo`; }
function flowCreditLabel(balance) {
  if (balance?.status === 'observed') return `Solde Flow : ${balance.remaining.toLocaleString('fr')} crédits · relevé le ${date(balance.observedAt)}`;
  return balance ? 'Solde Flow indisponible au dernier relevé' : '';
}
function safeFileURL(url) {
  if (shared) {
    try { const resource = new URL(url); return resource.origin === new URL(config.apiBase || location.origin).origin && /^\/media\/[a-f0-9]{24}\/(full|part-[123])\.mp4$/.test(resource.pathname); } catch { return false; }
  }
  if (local) return /^\/media\/[a-f0-9]{24}\/(full|part-[123])\.mp4$/.test(url || '');
  return typeof url === 'string' && url.startsWith(`https://github.com/${config.owner}/${config.repository}/releases/download/`);
}
function streamURL(file) {
  if (file.streamUrl && Date.parse(file.streamExpiresAt) > Date.now() && new URL(file.streamUrl).hostname === 'release-assets.githubusercontent.com') return file.streamUrl;
  return null;
}
function markDownload(entry, file) {
  downloaded[`${entry.id}/${file.kind}`] = new Date().toISOString(); store('workflowai-downloads', downloaded);
  renderLibrary();
}
async function binaryFile(file) {
  if (!file.assetId) throw new Error('Cette vidéo est encore en cours de synchronisation.');
  const response = await request(`${repo()}/releases/assets/${file.assetId}`, {}, true);
  if (response.headers.get('content-type')?.includes('json')) throw new Error('Utilise le lien GitHub de cette vidéo pour la récupérer.');
  return response.blob();
}
async function download(entry, file, button) {
  button.disabled = true; const original = button.textContent; button.textContent = 'Préparation…';
  try {
    if (local) {
      const a = element('a'), url = new URL(shared && streamURL(file) || file.url, location.href); if (!shared || !streamURL(file)) url.searchParams.set('download', '1'); a.href = url.href; a.download = `${entry.title}-${file.kind}.mp4`; document.body.append(a); a.click(); a.remove();
    } else if (streamURL(file)) {
      const a = element('a'); a.href = streamURL(file); a.download = `${entry.title}-${file.kind}.mp4`; a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove();
    } else {
      const a = element('a'); a.href = file.url; a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove();
    }
    markDownload(entry, file); notice('Téléchargement demandé. Le lien reste dans ta bibliothèque.');
  } catch (error) {
    notice(`${error.message} Le lien « Ouvrir sur GitHub » reste disponible avec ton compte connecté.`);
  } finally { button.disabled = false; button.textContent = original; }
}
async function play(entry, file, button) {
  $('player-title').textContent = `${entry.title} · ${file.label}`; $('player-message').textContent = 'Chargement de la vidéo…';
  $('player-dialog').showModal(); button.disabled = true;
  try {
    const direct = shared ? streamURL(file) || file.url : local ? file.url : streamURL(file);
    if (!direct) throw new Error('Le Mac doit renouveler le lien de lecture. Le téléchargement reste disponible via « Ouvrir sur GitHub ».');
    const src = direct;
    if (!$('player-dialog').open) { if (!local) URL.revokeObjectURL(src); return; }
    if (!direct) playerURL = src;
    $('player').src = src; $('player-message').textContent = ''; $('player').load();
  } catch (error) { $('player-message').textContent = error.message; }
  finally { button.disabled = false; }
}
function closePlayer() { $('player').pause(); $('player').removeAttribute('src'); $('player').load(); if (playerURL) URL.revokeObjectURL(playerURL); playerURL = null; }
$('close-player').addEventListener('click', () => $('player-dialog').close());
$('player-dialog').addEventListener('close', closePlayer);
function renderLibrary() {
  const search = $('search').value.toLocaleLowerCase('fr');
  const entries = dashboard.library.filter(entry => entry.title.toLocaleLowerCase('fr').includes(search));
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const card = $('library-card').content.firstElementChild.cloneNode(true); card.id = `video-${entry.id}`;
    if (entry.cover) card.querySelector('img').src = entry.cover;
    card.querySelector('h3').textContent = entry.title;
    card.querySelector('.card-meta').textContent = `${entry.scenes} scènes · ${duration(entry.duration)} · ${date(entry.createdAt)}`;
    card.querySelector('.card-music').textContent = entry.music ? `♫ ${entry.music}` : 'Dialogues d’origine · sans musique';
    if (entry.flowCredits) card.querySelector('.card-summary').append(element('p', flowCreditLabel(entry.flowCredits), 'card-credits'));
    const files = [...entry.files].sort((a, b) => (a.kind === 'full') - (b.kind === 'full'));
    for (const file of files) {
      const row = element('div', undefined, 'file-row'), info = element('div', undefined, 'file-info');
      info.append(element('strong', file.label), element('small', fileMeta(file)));
      const stamp = downloaded[`${entry.id}/${file.kind}`];
      if (stamp) info.append(element('span', `↓ Demandé le ${date(stamp)}`, 'download-mark'));
      const actions = element('div', undefined, 'file-actions');
      if (safeFileURL(file.url)) {
        const preview = element('button', '▷ Voir', 'play-button'); preview.type = 'button'; preview.setAttribute('aria-label', `Voir ${entry.title}, ${file.label}`);
        preview.addEventListener('click', () => play(entry, file, preview));
        const save = element('button', 'Télécharger ↓', 'download-button'); save.type = 'button'; save.addEventListener('click', () => download(entry, file, save));
        actions.append(preview, save);
      } else actions.append(element('span', 'Synchronisation…', 'hint'));
      row.append(info, actions); card.querySelector('.card-files').append(row);
    }
    card.querySelector('.remix').addEventListener('click', () => { $('mode').value = 'finish'; $('story').value = entry.story; updateForm(); tab('create'); $('music').focus(); });
    card.querySelector('.copy-link').addEventListener('click', async () => {
      const url = `${location.origin}${location.pathname}#video=${entry.id}`;
      try { await navigator.clipboard.writeText(url); notice('Lien de cette histoire copié. La connexion à ton compte reste nécessaire pour accéder aux vidéos privées.'); }
      catch { notice(`Lien de cette histoire : ${url}`); }
    });
    if (entry.releaseUrl?.startsWith(`https://github.com/${config.owner}/${config.repository}/releases/`)) {
      const a = element('a', 'Ouvrir sur GitHub ↗', 'text-button'); a.href = entry.releaseUrl; a.target = '_blank'; a.rel = 'noopener'; card.querySelector('.card-footer').append(a);
    }
    fragment.append(card);
  }
  $('library').replaceChildren(fragment); $('library-empty').hidden = entries.length > 0;
  $('library-count').textContent = dashboard.library.length;
  $('empty-description').textContent = search ? 'Aucune histoire ne correspond à ta recherche.' : connected() ? 'Une livraison terminée est ajoutée automatiquement ici.' : 'Connecte ton compte pour retrouver les vidéos déjà générées.';
}
$('search').addEventListener('input', renderLibrary);
function renderActivity() {
  const fragment = document.createDocumentFragment();
  for (const job of dashboard.jobs) {
    const card = element('article', undefined, 'job-card'), heading = element('div', undefined, 'job-heading'), title = element('div');
    const operation = ({ generate: 'Nouvelle histoire', resume: 'Reprise', finish: 'Finition / musique', check: 'Vérification sans génération' })[job.mode] || '';
    title.append(element('h3', job.title || 'Nouvelle histoire'), element('p', `${date(job.createdAt)} · ${operation}`, 'job-meta'));
    heading.append(title, element('span', statusLabels[job.status] || job.status, 'badge')); card.append(heading);
    const index = stageIds.indexOf(job.stage), label = job.status === 'queued' ? 'En attente du Mac' : job.mode === 'check' && job.status === 'complete' ? 'Vérification terminée' : job.detail?.message || stageLabels[index] || 'Vérification du projet';
    const progressHeading = element('div', undefined, 'progress-header');
    progressHeading.append(element('span', label), element('span', `${job.percent || 0} % des étapes`));
    const bar = element('progress'); bar.max = 100; bar.value = job.percent || 0; bar.setAttribute('aria-label', 'Avancement des étapes');
    const steps = element('ol', undefined, 'steps');
    for (let i = 0; i < 7; i++) { const li = element('li', stageLabels[i], i === index ? 'active' : i < index ? 'done' : ''); steps.append(li); }
    card.append(progressHeading, bar);
    if (job.mode !== 'check') card.append(steps);
    if (job.counts?.total) {
      const counters = element('div', undefined, 'counters');
      for (const [name, value] of [['Images', job.counts.images], ['Vidéos', job.counts.videos]]) { const counter = element('span', `${name} `); counter.append(element('strong', `${value} / ${job.counts.total}`)); counters.append(counter); }
      card.append(counters);
    }
    if (job.startedAt) {
      const end = job.completedAt ? Date.parse(job.completedAt) : Date.now();
      card.append(element('p', `${job.status === 'complete' ? 'Durée' : 'Temps écoulé'} : ${Math.max(0, Math.floor((end - Date.parse(job.startedAt)) / 60000))} min · les compteurs correspondent aux fichiers enregistrés.`, 'hint'));
    }
    if (job.error) card.append(element('p', job.error, 'job-error'));
    if (job.flowCredits) card.append(element('p', flowCreditLabel(job.flowCredits), 'card-credits'));
    const actions = element('div', undefined, 'job-actions');
    if (job.status === 'complete' && job.mode !== 'check') { const button = element('button', 'Retrouver mes vidéos →', 'text-button'); button.addEventListener('click', () => { $('search').value = ''; renderLibrary(); tab('library'); }); actions.append(button); }
    if (job.status === 'failed' && job.story) { const button = element('button', 'Reprendre les scènes existantes →', 'text-button'); button.addEventListener('click', () => { $('mode').value = 'resume'; $('story').value = job.story; updateForm(); tab('create'); }); actions.append(button); }
    if (job.runUrl?.startsWith(`https://github.com/${config.owner}/${config.repository}/actions/runs/`)) { const a = element('a', 'Journal GitHub ↗'); a.href = job.runUrl; a.target = '_blank'; a.rel = 'noopener'; actions.append(a); }
    card.append(actions); fragment.append(card);
  }
  $('activity').replaceChildren(fragment); $('activity-empty').hidden = dashboard.jobs.length > 0;
  $('active-count').textContent = dashboard.jobs.filter(job => ['queued', 'running'].includes(job.status)).length;
}
function render() {
  fillChoices(); renderLibrary(); renderActivity(); updateForm();
  const online = shared ? studioClient.online : local || dashboard.heartbeat && Date.now() - Date.parse(dashboard.heartbeat) < 95000;
  $('mac-status').textContent = !connected() ? 'Connexion requise' : online ? 'Mac connecté' : 'Reconnexion…';
  $('mac-status').classList.toggle('offline', connected() && !online);
  $('sync-status').textContent = !connected() ? 'Connecte ton compte pour retrouver les traitements.' : online ? `Actualisé ${dashboard.heartbeat ? date(dashboard.heartbeat) : 'maintenant'} · actualisation automatique.` : 'Le serveur se reconnecte. Ton accès et le dernier état affiché sont conservés.';
  $('logout').hidden = !shared || !connected();
}
async function refresh() {
  if (refreshing || !connected()) return;
  refreshing = true;
  try {
    let next;
    if (local) next = await request('/api/dashboard');
    else {
      const response = await request(`${repo()}/contents/catalog.json?ref=${dataRef()}`);
      next = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(response.content.replace(/\s/g, '')), char => char.charCodeAt(0))));
      if (Date.now() - runsUpdatedAt > 20000) {
        const result = await request(`${repo()}/actions/workflows/${config.workflow}/runs?event=workflow_dispatch&per_page=50`);
        remoteRuns = result.workflow_runs; runsUpdatedAt = Date.now();
      }
      for (const run of remoteRuns) {
        const match = run.display_title.match(/^(generate|resume|finish|check)\s*·\s*([a-zA-Z0-9-]{6,100})$/);
        if (!match) continue;
        const [, mode, id] = match;
        let job = next.jobs.find(item => item.id === id);
        if (!job) {
          job = { id, mode, title: mode === 'generate' ? 'Nouvelle histoire' : 'Traitement demandé', createdAt: run.created_at, stage: 'story', percent: 0 };
          next.jobs.push(job);
        }
        job.runUrl = run.html_url; job.runId = run.id;
        if (run.status === 'completed' && run.conclusion !== 'success') {
          job.status = 'failed'; job.error ||= `Le traitement GitHub est ${run.conclusion === 'cancelled' ? 'annulé' : 'arrêté'}. Consulte le journal pour le reprendre.`;
        } else if (!job.status) {
          job.status = run.status === 'completed' ? 'complete' : run.status === 'in_progress' ? 'running' : 'queued';
          if (job.status === 'complete') { job.stage = 'done'; job.percent = 100; }
          else if (job.status === 'running') job.detail = { message: 'Démarrage du traitement sur le Mac' };
        }
      }
    }
    for (const [name, at] of recentImports) {
      if (next.music.includes(name) || Date.now() - at > 30000) recentImports.delete(name);
      else next.music.push(name);
    }
    pending = pending.filter(job => !next.jobs.some(item => item.id === job.id)); store('workflowai-pending', pending);
    next.jobs = [...pending, ...next.jobs]; dashboard = next;
    if (pendingImport) {
      const imported = dashboard.imports.find(item => item.id === pendingImport.id);
      if (imported) {
        $('upload-message').textContent = imported.status === 'ready' ? `✓ ${imported.name} est prêt à être utilisé.` : imported.error;
        if (imported.status === 'ready') { selectedMusic = imported.name; $('upload-bar').value = 100; }
        pendingImport = null; store('workflowai-import', null);
      }
    }
    render();
    if ($('global-message').textContent.startsWith('Le serveur se reconnecte')) notice('Connexion rétablie.');
  } catch (error) { notice(error.message); render(); }
  finally { refreshing = false; clearTimeout(timer); timer = setTimeout(refresh, shared && !studioClient.online ? 10000 : local ? 3000 : 10000); }
}
$('refresh').addEventListener('click', refresh);
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); token = $('token').value.trim(); $('token').value = ''; $('connect').disabled = true;
  try {
    if (shared) {
      const code = token; token = '';
      await studioClient.login(code);
      $('auth-message').textContent = ''; $('auth').hidden = true; $('open-auth').textContent = 'Mon accès';
      await refresh(); return;
    }
    if (!token) throw new Error('Renseigne ton token personnel GitHub.');
    const user = await request('https://api.github.com/user');
    if (user.login.toLowerCase() !== config.owner.toLowerCase()) throw new Error('Connecte le compte propriétaire du studio.');
    await request(`${repo()}/actions/workflows/${config.workflow}`);
    $('auth-message').textContent = ''; $('auth').hidden = true; $('open-auth').textContent = 'Compte'; $('open-auth').title = user.login;
    await refresh();
    const id = new URLSearchParams(location.hash.slice(1)).get('video');
    if (id && /^[a-f0-9]{24}$/.test(id)) document.getElementById(`video-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) { token = ''; $('auth-message').textContent = error.message; }
  finally { $('connect').disabled = false; }
});
$('generate-form').addEventListener('submit', async event => {
  event.preventDefault(); busy = true; updateForm(); $('form-message').textContent = '';
  const input = { mode: $('mode').value, story: $('story').value, music: $('music').value, musicVolume: Number($('volume').value) / 100, creditLimit: Number($('budget').value) };
  try {
    let job;
    if (local) job = await request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    else {
      const id = crypto.randomUUID();
      await request(`${repo()}/actions/workflows/${config.workflow}/dispatches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: config.ref, inputs: { mode: input.mode, story: input.story, music: input.music, music_volume: String(input.musicVolume), credit_limit: String(input.creditLimit), request_id: id } }) });
      job = { id, ...input, title: input.mode === 'generate' ? 'Nouvelle histoire' : dashboard.stories.find(s => s.id === input.story)?.title, status: 'queued', stage: 'story', percent: 0, createdAt: new Date().toISOString() };
      pending.unshift(job); store('workflowai-pending', pending);
    }
    dashboard.jobs.unshift(job); renderActivity(); tab('activity'); notice('Demande envoyée. Tu peux revenir plus tard : le traitement continue sur le Mac.'); await refresh();
  } catch (error) { $('form-message').textContent = error.message; }
  finally { busy = false; updateForm(); }
});
$('import-button').addEventListener('click', () => $('music-file').click());
$('music-file').addEventListener('change', async () => {
  const file = $('music-file').files[0]; if (!file) return;
  $('upload-progress').hidden = false; $('upload-bar').value = 0;
  try {
    if (!/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024) throw new Error('Choisis un fichier MP3, WAV, M4A, AAC, FLAC ou OGG de 20 Mo maximum.');
    busy = true; updateForm(); $('upload-message').textContent = 'Transfert de la musique…';
    if (local) {
      const imported = await request(`/api/music?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      recentImports.set(imported.name, Date.now());
      if (!dashboard.music.includes(imported.name)) dashboard.music.push(imported.name);
      selectedMusic = imported.name; fillChoices();
      $('upload-bar').value = 100; $('upload-message').textContent = `✓ ${imported.name} est prêt à être utilisé.`;
    } else {
      const id = crypto.randomUUID(), name = file.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._ -]/g, '-').slice(-120).replace(/^\.+/, '');
      const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.onprogress = event => { if (event.lengthComputable) $('upload-bar').value = Math.round(event.loaded / event.total * 25); }; reader.readAsDataURL(file); });
      await request(`${repo()}/contents/uploads/${encodeURIComponent(id + '--' + name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: config.dataRef || 'studio-data', message: 'Import studio music', content }) });
      pendingImport = { id, name }; store('workflowai-import', pendingImport); $('upload-bar').value = 65; $('upload-message').textContent = 'Fichier reçu en privé. Le Mac vérifie la piste audio avant de la proposer dans ta liste.';
    }
    await refresh();
  } catch (error) { $('upload-message').textContent = error.message; }
  finally { busy = false; $('music-file').value = ''; updateForm(); }
});
try {
  config = await request('config.json');
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
    const response = await fetch('/api/config'), info = response.ok ? await response.json() : {};
    local = info.mode === 'local' || info.mode === 'shared'; shared = info.mode === 'shared';
    if (shared) config.apiBase = '';
  } else if (config.apiBase) {
    const endpoint = new URL(config.apiBase);
    if (endpoint.protocol !== 'https:' || !/\.(trycloudflare\.com|lhr\.life)$/.test(endpoint.hostname)) throw new Error('Adresse du studio invalide.');
    shared = true; local = true;
  }
  if (shared) {
    studioClient = new StudioClient({ base: config.apiBase, storage: localStorage, legacyStorage: sessionStorage });
    document.querySelector('label[for=token]').textContent = 'Code d’accès au studio'; $('token').placeholder = 'Colle ton code d’accès';
    document.querySelector('#auth details summary').textContent = 'Comment obtenir le code ?';
    document.querySelector('#auth details p').textContent = 'Entre le code une seule fois sur cet appareil. La connexion reste mémorisée après fermeture du navigateur, jusqu’à une déconnexion ou un changement du code du studio. Aucun compte GitHub n’est nécessaire.';
    $('open-auth').textContent = 'Mon accès';
    if (connected()) {
      try { await studioClient.restore(); } catch (error) { notice(error.message); }
    }
  }
  $('auth').hidden = connected(); $('open-auth').hidden = local && !shared;
  if (connected()) await refresh();
  else { $('mac-status').textContent = 'Connexion requise'; render(); }
} catch (error) { notice(error.message); }
