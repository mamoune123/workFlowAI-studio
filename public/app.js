import { StudioClient, StudioAuthError } from './studio-client.js?v=persistent-access-3';

const $ = id => document.getElementById(id);
const STAGES = ['story', 'images', 'videos', 'assembly', 'subtitles', 'music', 'split', 'done'];
const STAGE_LABELS = ['Script', 'Images', 'Vidéos', 'Montage', 'Sous-titres', 'Musique', 'Parties', 'Prêt'];
const STAGE_DOING = ['Claude écrit le script', 'Création des images', 'Animation des clips', 'Montage des clips', 'Ajout des sous-titres', 'Mixage de la musique', 'Découpage des parties', 'Livraison prête'];
const STATUS = { queued: ['En attente', 'queued'], running: ['En cours', 'running'], complete: ['Terminé', 'complete'], failed: ['Interrompu', 'failed'] };
const STYLE_EMOJI = { fruits: '🍓', ongles: '💅', objets: '🫖', pierres: '💎' };
const MODE_LABEL = { generate: 'Nouvelle histoire · partie 1', continue: 'Partie suivante', resume: 'Reprise', finish: 'Musique / finition', check: 'Vérification' };

let config, local = false, shared = false, token = '', studioClient;
let dashboard = { music: [], stories: [], jobs: [], library: [], imports: [] };
let mode = 'generate', activeTab = 'create', firstLoad = true;
let timer, busy = false, refreshing = false, selectedMusic = '', pendingImport, toastTimer, openEntry = null;
const getStored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
let pending = getStored('workflowai-pending', []).filter(job => Date.now() - Date.parse(job.createdAt) < 86400000);
pendingImport = getStored('workflowai-import', null);
let remoteRuns = [], runsUpdatedAt = 0;
const recentImports = new Map();
const downloaded = getStored('workflowai-downloads', {});
const copied = getStored('workflowai-copied', {});

const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, className, onClick) => { const node = element('button', text, className); node.type = 'button'; node.addEventListener('click', onClick); return node; };
function toast(text) {
  if (!text) return;
  clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
const notice = toast;
const connected = () => shared ? Boolean(studioClient?.connected) : local || Boolean(token);
const online = () => shared ? studioClient.online : local || Boolean(dashboard.heartbeat && Date.now() - Date.parse(dashboard.heartbeat) < 95000);
const repo = () => `https://api.github.com/repos/${config.owner}/${config.repository}`;
const dataRef = () => encodeURIComponent(config.dataRef || 'studio-data');
const date = value => new Intl.DateTimeFormat('fr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const duration = seconds => { const total = Math.round(seconds || 0); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };
const minutes = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };

async function request(url, options = {}, binary = false) {
  if (shared && url.startsWith('/')) {
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
    if ([401, 403].includes(response.status)) throw new Error(shared ? 'Accès refusé au studio.' : 'Connexion refusée : vérifie le token et ses permissions Actions / Contents.');
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || (response.status === 404 ? 'Fichier privé introuvable.' : `Erreur ${response.status}. Réessaie dans un instant.`));
  }
  return binary ? response : response.status === 204 ? null : response.json();
}

// ---------- Navigation ----------
function tab(name) {
  activeTab = name;
  document.querySelectorAll('.nav-item').forEach(item => {
    const active = item.dataset.tab === name;
    item.classList.toggle('active', active); item.setAttribute('aria-current', active ? 'page' : 'false');
  });
  for (const view of ['create', 'activity', 'library']) $(`view-${view}`).hidden = view !== name;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}
document.querySelectorAll('[data-tab]').forEach(item => item.addEventListener('click', () => tab(item.dataset.tab)));
document.querySelectorAll('[data-go]').forEach(item => item.addEventListener('click', () => tab(item.dataset.go)));
$('open-auth').addEventListener('click', () => { $('auth').hidden = !$('auth').hidden; if (!$('auth').hidden) { window.scrollTo({ top: 0 }); $('token').focus(); } });
$('logout').addEventListener('click', async () => {
  try { await studioClient.logout(); } catch { toast('Accès oublié sur cet appareil.'); }
  dashboard = { music: [], stories: [], jobs: [], library: [], imports: [] };
  $('auth').hidden = false; render();
});

// ---------- Formulaire ----------
function setMode(next) {
  mode = next;
  document.querySelectorAll('.seg').forEach(seg => {
    const active = seg.dataset.mode === (next === 'check' ? 'resume' : next);
    seg.classList.toggle('active', active); seg.setAttribute('aria-selected', String(active));
  });
  $('form-message').textContent = '';
  updateForm();
}
document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', () => setMode(seg.dataset.mode)));
$('check-button').addEventListener('click', () => { setMode('check'); $('story').focus(); });

const selectedStyle = () => document.querySelector('input[name=style]:checked')?.value || 'fruits';
function updateForm() {
  const isNew = mode === 'generate';
  $('new-fields').hidden = !isNew;
  $('story-field').hidden = isNew;
  $('import-button').closest('.card').hidden = mode === 'check';
  $('budget-field').hidden = ['finish', 'check'].includes(mode);
  $('music-step').textContent = isNew ? '3' : '2';
  $('volume-field').hidden = !$('music').value;
  $('story-label').textContent = ({ continue: 'Quelle série continuer ?', resume: 'Quelle histoire reprendre ?', finish: 'Pour quelle histoire ?', check: 'Quelle histoire vérifier ?' })[mode] || '';
  $('subtitles-field').hidden = mode === 'check';
  $('model-field').hidden = ['finish', 'check'].includes(mode);
  $('subtitles-hint').textContent = $('subtitles').checked ? 'Activés : les dialogues sont incrustés en bas de la vidéo.' : 'Désactivés : la vidéo est livrée sans texte incrusté.';
  fillStories();
  $('story-hint').textContent = ({
    continue: 'Claude écrit la partie suivante avec les mêmes personnages, en reprenant le cliffhanger.',
    resume: 'Les images et vidéos déjà faites sont gardées : seules les manquantes sont générées.',
    finish: 'Change la musique ou les sous-titres et refait les parties déjà générées. Aucun crédit Flow.',
    check: 'Contrôle ce qui manque, sans rien générer et sans dépenser de crédit.',
  })[mode] || '';
  $('summary').textContent = ({
    generate: `${STYLE_EMOJI[selectedStyle()]} Partie 1 · 6-7 clips de 10 s · ${partCost()} · ≈ 25 min`,
    continue: `${nextPartLabel()} · 6-7 clips de 10 s · ${partCost()} · ≈ 25 min`,
    resume: 'Reprend là où ça s’est arrêté · crédits seulement pour ce qui manque',
    finish: 'Musique et sous-titres refaits · 0 crédit',
    check: 'Vérification · 0 crédit',
  })[mode];
  $('generate').replaceChildren(document.createTextNode(({ generate: 'Lancer la partie 1 ', continue: `Lancer la ${nextPartLabel().toLowerCase()} `, resume: 'Reprendre ', finish: 'Refaire mes vidéos ', check: 'Vérifier ' })[mode]), element('span', ({ generate: '✦', continue: '✦', resume: '↻', finish: '♫', check: '✓' })[mode]));
  const active = dashboard.jobs.some(job => ['queued', 'running'].includes(job.status));
  const offline = shared && !studioClient.online;
  $('generate').disabled = !connected() || busy || active || offline;
  $('import-button').disabled = !connected() || busy || offline;
  if (!connected()) $('form-message').textContent = 'Connecte-toi pour lancer une création.';
  else if (active) $('form-message').textContent = 'Une création est déjà en cours : suis-la dans Suivi.';
  else if (offline) $('form-message').textContent = 'Le Mac se reconnecte…';
  else if (/^(Connecte-toi|Une création|Le Mac)/.test($('form-message').textContent)) $('form-message').textContent = '';
}
document.querySelectorAll('input[name=style]').forEach(input => input.addEventListener('change', updateForm));
$('subtitles').addEventListener('change', updateForm);
const selectedModel = () => document.querySelector('input[name=video-model]:checked')?.value || 'omni-1.1';
const partCost = () => selectedModel() === 'omni-1.2' ? '≈ 180-210 crédits' : '≈ 90-105 crédits';
document.querySelectorAll('input[name=video-model]').forEach(input => input.addEventListener('change', () => {
  try { localStorage.setItem('workflowai-model', selectedModel()); } catch {}
  updateForm();
}));
try { const saved = localStorage.getItem('workflowai-model'); if (saved) document.querySelector(`input[name=video-model][value="${saved === 'omni-1.2' ? 'omni-1.2' : 'omni-1.1'}"]`).checked = true; } catch {}
$('story').addEventListener('change', updateForm);
// Next part of the selected series, from its latest delivery.
function nextPartLabel() {
  const entry = dashboard.library.find(item => item.story === $('story').value);
  return entry?.nextPart ? `Partie ${entry.nextPart}` : 'Partie suivante';
}
// "Continuer" only lists V4 series; other modes list every story.
function fillStories() {
  const wanted = mode === 'continue' ? dashboard.stories.filter(item => item.style) : dashboard.stories;
  const current = $('story').value;
  if ($('story').dataset.mode === mode && $('story').options.length === wanted.length + 1) return;
  $('story').dataset.mode = mode;
  $('story').replaceChildren(Object.assign(element('option', mode === 'continue' ? 'Choisir une série…' : 'Choisir une histoire…'), { value: '' }));
  for (const item of wanted) $('story').append(Object.assign(element('option', `${STYLE_EMOJI[item.style] ? STYLE_EMOJI[item.style] + ' ' : ''}${item.title} · ${item.id.slice(6, 16)}`), { value: item.id }));
  if (wanted.some(item => item.id === current)) $('story').value = current;
}
$('music').addEventListener('change', updateForm);
$('volume').addEventListener('input', () => { $('volume-value').textContent = `${$('volume').value} %`; });
$('idea').addEventListener('input', () => {
  const length = $('idea').value.length;
  $('idea-count').textContent = length ? `${length} caractères` : '';
  try { sessionStorage.setItem('workflowai-idea', $('idea').value); } catch {}
});
try { $('idea').value = sessionStorage.getItem('workflowai-idea') || ''; $('idea-count').textContent = $('idea').value.length ? `${$('idea').value.length} caractères` : ''; } catch {}

function fillChoices() {
  const music = selectedMusic || $('music').value;
  delete $('story').dataset.mode; fillStories();
  $('music').replaceChildren(Object.assign(element('option', 'Sans musique, dialogues seuls'), { value: '' }));
  for (const name of dashboard.music) $('music').append(Object.assign(element('option', name), { value: name }));
  if (dashboard.music.includes(music)) { $('music').value = music; selectedMusic = ''; }
}

// ---------- Vidéos ----------
const MEDIA_PATH = /^\/media\/[a-f0-9]{24}\/((full|part-[1-9][0-9]?)\.mp4|cover-[1-9][0-9]?\.png)$/;
function safeFileURL(url) {
  if (shared) {
    try { const resource = new URL(url); return resource.origin === new URL(config.apiBase || location.origin).origin && MEDIA_PATH.test(resource.pathname); } catch { return false; }
  }
  if (local) return MEDIA_PATH.test(url || '');
  return typeof url === 'string' && url.startsWith(`https://github.com/${config.owner}/${config.repository}/releases/download/`);
}
function streamURL(file) {
  if (file.streamUrl && Date.parse(file.streamExpiresAt) > Date.now() && new URL(file.streamUrl).hostname === 'release-assets.githubusercontent.com') return file.streamUrl;
  return null;
}
function clickLink(href, filename, external = false) {
  const a = element('a'); a.href = href; if (filename) a.download = filename; if (external) { a.target = '_blank'; a.rel = 'noopener'; }
  document.body.append(a); a.click(); a.remove();
}
async function download(entry, file, control) {
  control.disabled = true; const original = control.textContent; control.textContent = 'Préparation…';
  try {
    const name = `${entry.title}-${file.kind}.${file.kind.startsWith('cover-') ? 'png' : 'mp4'}`;
    if (local) { const url = new URL(shared && streamURL(file) || file.url, location.href); if (!shared || !streamURL(file)) url.searchParams.set('download', '1'); clickLink(url.href, name); }
    else if (streamURL(file)) clickLink(streamURL(file), name, true);
    else clickLink(file.url, null, true);
    downloaded[`${entry.id}/${file.kind}`] = new Date().toISOString(); store('workflowai-downloads', downloaded);
    toast('Téléchargement lancé ↓');
    if (openEntry?.id === entry.id) renderSheet(entry);
  } catch (error) { toast(error.message); }
  finally { control.disabled = false; control.textContent = original; }
}
async function play(entry, file) {
  $('player-title').textContent = `${entry.title} · ${file.label}`; $('player-message').textContent = 'Chargement…';
  $('player-dialog').showModal();
  try {
    const src = shared ? streamURL(file) || file.url : local ? file.url : streamURL(file);
    if (!src) throw new Error('Le Mac renouvelle le lien de lecture. Réessaie dans une minute, ou télécharge la vidéo.');
    $('player').src = src; $('player-message').textContent = ''; $('player').load();
  } catch (error) { $('player-message').textContent = error.message; }
}
$('close-player').addEventListener('click', () => $('player-dialog').close());
$('player-dialog').addEventListener('close', () => { $('player').pause(); $('player').removeAttribute('src'); $('player').load(); });

async function copy(text, key, message) {
  try { await navigator.clipboard.writeText(text); } catch {
    const area = element('textarea'); area.value = text; document.body.append(area); area.select(); document.execCommand?.('copy'); area.remove();
  }
  if (key) { copied[key] = new Date().toISOString(); store('workflowai-copied', copied); }
  toast(message || 'Copié ✓');
  if (openEntry) renderSheet(openEntry);
}
function renderSheet(entry) {
  openEntry = entry;
  $('sheet-eyebrow').textContent = `${STYLE_EMOJI[entry.style] || '🎬'} ${entry.scenes} clips · ${duration(entry.duration)} · ${date(entry.createdAt)}`;
  $('sheet-title').textContent = entry.title;
  $('sheet-paradox').textContent = entry.social?.paradox || (entry.music ? `♫ ${entry.music}` : '');
  const parts = [...entry.files].sort((a, b) => (a.kind === 'full') - (b.kind === 'full'));
  const fragment = document.createDocumentFragment();
  for (const file of parts) {
    const number = Number(file.kind.match(/part-(\d)/)?.[1]);
    const social = entry.social?.parts?.find(p => p.part === number);
    const box = element('article', undefined, 'part');
    const head = element('div', undefined, 'part-head');
    const thumb = social?.cover || (number === 1 && entry.social ? entry.cover : null);
    if (thumb) { const img = element('img', undefined, 'part-thumb'); img.src = thumb; img.alt = ''; head.append(img); }
    const info = element('div', undefined, 'grow');
    info.append(element('strong', file.label), element('small', `${file.scenes ? `${file.scenes} clips · ` : ''}${duration(file.duration)} · ${Math.max(1, Math.round(file.bytes / 1048576))} Mo`));
    const stamp = downloaded[`${entry.id}/${file.kind}`];
    if (stamp) info.append(element('span', ` · ↓ téléchargée`, 'done-mark'));
    head.append(info); box.append(head);
    const actions = element('div', undefined, 'part-buttons');
    if (safeFileURL(file.url)) {
      actions.append(button('▷ Voir', 'play', () => play(entry, file)));
      const save = button('↓ Télécharger', '', () => download(entry, file, save)); actions.append(save);
    } else actions.append(element('span', 'Synchronisation en cours…', 'hint'));
    const coverFile = entry.covers?.find(c => c.part === number);
    if (coverFile && safeFileURL(coverFile.url)) {
      const label = downloaded[`${entry.id}/${coverFile.kind}`] ? '✓ Miniature téléchargée' : '🖼️ Télécharger la miniature';
      const get = button(label, 'cover-button', () => download(entry, coverFile, get)); actions.append(get);
    }
    box.append(actions);
    if (social?.caption) {
      const caption = element('p', social.caption + ' ', 'caption');
      caption.append(element('span', social.hashtags.join(' '), 'tags'));
      const row = element('div', undefined, 'copy-row');
      const key = `${entry.id}/caption-${number}`;
      row.append(button(copied[key] ? '✓ Légende copiée' : 'Copier la légende', 'link-button', () => copy(`${social.caption}\n\n${social.hashtags.join(' ')}`, key, 'Légende + hashtags copiés ✓')));
      if (social.pinned_comment) {
        const pinKey = `${entry.id}/pin-${number}`;
        row.append(button(copied[pinKey] ? '✓ Commentaire copié' : 'Copier le commentaire épinglé', 'link-button', () => copy(social.pinned_comment, pinKey, 'Commentaire à épingler copié ✓')));
      }
      box.append(caption, row);
    }
    fragment.append(box);
  }
  $('sheet-parts').replaceChildren(fragment);
  $('sheet-continue').hidden = !entry.nextPart;
  $('sheet-continue').textContent = `✦ Continuer : partie ${entry.nextPart}`;
  const github = entry.releaseUrl?.startsWith(`https://github.com/${config.owner}/${config.repository}/releases/`);
  $('sheet-github').hidden = !github; if (github) $('sheet-github').href = entry.releaseUrl;
}
function openSheet(entry) { renderSheet(entry); if (!$('story-dialog').open) $('story-dialog').showModal(); }
$('close-sheet').addEventListener('click', () => $('story-dialog').close());
$('story-dialog').addEventListener('close', () => { openEntry = null; });
for (const dialog of [$('story-dialog'), $('player-dialog')]) dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
$('sheet-continue').addEventListener('click', () => {
  const story = openEntry?.story; $('story-dialog').close(); setMode('continue'); $('story').value = story || ''; updateForm(); tab('create');
});
$('sheet-music').addEventListener('click', () => {
  const story = openEntry?.story; $('story-dialog').close(); setMode('finish'); $('story').value = story || ''; tab('create'); $('music').focus();
});
$('sheet-link').addEventListener('click', () => { if (openEntry) copy(`${location.origin}${location.pathname}#video=${openEntry.id}`, null, 'Lien copié. L’accès au studio reste nécessaire pour voir la vidéo.'); });

function renderLibrary() {
  const search = $('search').value.toLocaleLowerCase('fr');
  const entries = dashboard.library.filter(entry => entry.title.toLocaleLowerCase('fr').includes(search));
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const card = $('library-card').content.firstElementChild.cloneNode(true); card.id = `video-${entry.id}`;
    if (entry.cover) card.querySelector('img').src = entry.cover;
    card.querySelector('.cover-style').textContent = STYLE_EMOJI[entry.style] || '';
    card.querySelector('.video-title').textContent = entry.title;
    card.querySelector('.video-meta').textContent = `${entry.parts || 3} partie${(entry.parts || 3) > 1 ? 's' : ''} · ${duration(entry.duration)} · ${new Intl.DateTimeFormat('fr', { day: 'numeric', month: 'short' }).format(new Date(entry.createdAt))}`;
    card.setAttribute('aria-label', `${entry.title}, ouvrir`);
    card.addEventListener('click', () => openSheet(entry));
    fragment.append(card);
  }
  $('library').replaceChildren(fragment); $('library-empty').hidden = entries.length > 0;
  $('library-count').textContent = dashboard.library.length;
  $('empty-title').textContent = search ? 'Aucun résultat' : 'Pas encore de vidéo';
  $('empty-description').textContent = search ? 'Aucune histoire ne correspond à ta recherche.' : connected() ? 'Chaque partie terminée arrive ici automatiquement.' : 'Connecte-toi pour retrouver tes vidéos.';
  if (openEntry) { const fresh = dashboard.library.find(e => e.id === openEntry.id); if (fresh) renderSheet(fresh); }
}
$('search').addEventListener('input', renderLibrary);

// ---------- Suivi ----------
function jobActions(job) {
  const actions = element('div', undefined, 'job-actions');
  if (job.status === 'complete' && job.mode !== 'check') actions.append(button('Voir mes vidéos →', 'link-button', () => { $('search').value = ''; renderLibrary(); tab('library'); }));
  if (job.status === 'complete' && job.style && job.story && ['generate', 'continue'].includes(job.mode)) actions.append(button('✦ Continuer : partie suivante →', 'link-button', () => { setMode('continue'); $('story').value = job.story; updateForm(); tab('create'); }));
  if (job.status === 'failed' && job.story) actions.append(button('Reprendre là où ça s’est arrêté →', 'link-button', () => { setMode('resume'); $('story').value = job.story; tab('create'); }));
  if (job.runUrl?.startsWith(`https://github.com/${config.owner}/${config.repository}/actions/runs/`)) {
    const a = element('a', 'Journal ↗', 'link-button'); a.href = job.runUrl; a.target = '_blank'; a.rel = 'noopener'; actions.append(a);
  }
  return actions;
}
function jobTitle(job) { return `${STYLE_EMOJI[job.style] ? STYLE_EMOJI[job.style] + ' ' : ''}${job.title || 'Nouvelle histoire'}`; }
function renderCurrent(job) {
  const card = element('article', undefined, 'job-hero');
  const top = element('div', undefined, 'job-top'), title = element('div');
  title.append(element('h2', jobTitle(job)), element('p', `${MODE_LABEL[job.mode] || ''} · lancée ${date(job.createdAt)}`, 'job-sub'));
  const [label, kind] = STATUS[job.status] || [job.status, ''];
  top.append(title, element('span', label, `badge ${kind}`)); card.append(top);
  const index = Math.max(0, STAGES.indexOf(job.stage));
  const doing = job.status === 'queued' ? 'En attente du Mac…' : job.mode === 'check' ? 'Vérification' : job.detail?.message || STAGE_DOING[index];
  const line = element('div', undefined, 'progress-line'); line.append(element('strong', doing), element('span', `${job.percent || 0} %`));
  const bar = element('progress'); bar.max = 100; bar.value = job.percent || 0; bar.setAttribute('aria-label', 'Avancement');
  card.append(line, bar);
  if (job.mode !== 'check') {
    const steps = element('ol', undefined, 'stepper');
    for (let i = 0; i < 7; i++) steps.append(element('li', STAGE_LABELS[i], i === index ? 'active' : i < index ? 'done' : ''));
    card.append(steps);
  }
  const counters = element('div', undefined, 'counters');
  const box = (name, value) => { const node = element('div', undefined, 'counter-box'); node.append(element('small', name), element('b', value)); return node; };
  if (job.counts?.total) counters.append(box('Images', `${job.counts.images}/${job.counts.total}`), box('Vidéos', `${job.counts.videos}/${job.counts.total}`));
  if (job.startedAt) counters.append(box('Temps', minutes((job.completedAt ? Date.parse(job.completedAt) : Date.now()) - Date.parse(job.startedAt))));
  if (counters.childElementCount) card.append(counters);
  if (job.idea) card.append(element('p', `« ${job.idea.length > 140 ? job.idea.slice(0, 140) + '…' : job.idea} »`, 'job-note'));
  if (job.error) card.append(element('p', job.error, 'job-error'));
  if (['queued', 'running'].includes(job.status)) card.append(element('p', 'Tu peux fermer l’app : le Mac continue et tout se met à jour ici.', 'job-note'));
  const actions = jobActions(job); if (actions.childElementCount) card.append(actions);
  return card;
}
function renderActivity() {
  const jobs = dashboard.jobs;
  const current = jobs.find(job => ['queued', 'running'].includes(job.status)) || (jobs[0] && Date.now() - Date.parse(jobs[0].completedAt || jobs[0].createdAt) < 6 * 3600000 ? jobs[0] : null);
  $('current-job').replaceChildren(...(current ? [renderCurrent(current)] : []));
  const fragment = document.createDocumentFragment();
  for (const job of jobs.filter(job => job !== current).slice(0, 15)) {
    const item = element('article', undefined, 'history-item');
    item.append(element('span', STYLE_EMOJI[job.style] || (job.mode === 'finish' ? '♫' : '🎬'), 'history-emoji'));
    const grow = element('div', undefined, 'grow');
    grow.append(element('strong', job.title || 'Nouvelle histoire'), element('small', `${MODE_LABEL[job.mode] || ''} · ${date(job.createdAt)}`));
    const actions = jobActions(job); if (actions.childElementCount) grow.append(actions);
    const [label, kind] = STATUS[job.status] || [job.status, ''];
    item.append(grow, element('span', label, `badge ${kind}`));
    fragment.append(item);
  }
  $('activity').replaceChildren(fragment);
  $('history-title').hidden = !$('activity').childElementCount;
  $('activity-empty').hidden = Boolean(current || $('activity').childElementCount);
  const active = jobs.filter(job => ['queued', 'running'].includes(job.status)).length;
  $('active-count').textContent = active; $('active-count').hidden = !active;
}

// ---------- Rendu global ----------
function render() {
  fillChoices(); renderLibrary(); renderActivity(); updateForm();
  const pill = $('mac-status'), isOnline = connected() && online();
  pill.querySelector('span').textContent = !connected() ? 'Connexion requise' : isOnline ? 'Mac en ligne' : 'Mac hors ligne';
  pill.classList.toggle('online', isOnline); pill.classList.toggle('offline', connected() && !isOnline);
  $('sync-status').textContent = !connected() ? 'Connecte-toi pour suivre tes créations.' : isOnline ? `Mise à jour automatique · ${dashboard.heartbeat ? date(dashboard.heartbeat) : 'maintenant'}` : 'Le Mac se reconnecte. Le dernier état reste affiché.';
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
        const match = run.display_title.match(/^(generate|continue|resume|finish|check)\s*·\s*([a-zA-Z0-9-]{6,100})$/);
        if (!match) continue;
        const [, runMode, id] = match;
        let job = next.jobs.find(item => item.id === id);
        if (!job) { job = { id, mode: runMode, title: runMode === 'generate' ? 'Nouvelle histoire' : 'Traitement demandé', createdAt: run.created_at, stage: 'story', percent: 0 }; next.jobs.push(job); }
        job.runUrl = run.html_url; job.runId = run.id;
        if (run.status === 'completed' && run.conclusion !== 'success') { job.status = 'failed'; job.error ||= `Traitement ${run.conclusion === 'cancelled' ? 'annulé' : 'arrêté'}. Consulte le journal pour le reprendre.`; }
        else if (!job.status) {
          job.status = run.status === 'completed' ? 'complete' : run.status === 'in_progress' ? 'running' : 'queued';
          if (job.status === 'complete') { job.stage = 'done'; job.percent = 100; }
          else if (job.status === 'running') job.detail = { message: 'Démarrage sur le Mac' };
        }
      }
    }
    for (const [name, at] of recentImports) { if (next.music.includes(name) || Date.now() - at > 30000) recentImports.delete(name); else next.music.push(name); }
    pending = pending.filter(job => !next.jobs.some(item => item.id === job.id)); store('workflowai-pending', pending);
    next.jobs = [...pending, ...next.jobs]; dashboard = next;
    if (pendingImport) {
      const imported = dashboard.imports.find(item => item.id === pendingImport.id);
      if (imported) {
        $('upload-message').textContent = imported.status === 'ready' ? `✓ ${imported.name} est prêt.` : imported.error;
        if (imported.status === 'ready') { selectedMusic = imported.name; $('upload-bar').value = 100; }
        pendingImport = null; store('workflowai-import', null);
      }
    }
    render();
    if (firstLoad) {
      firstLoad = false;
      const id = new URLSearchParams(location.hash.slice(1)).get('video');
      const linked = id && dashboard.library.find(entry => entry.id === id);
      if (linked) { tab('library'); openSheet(linked); }
      else if (dashboard.jobs.some(job => ['queued', 'running'].includes(job.status))) tab('activity');
    }
  } catch (error) { toast(error.message); render(); }
  finally { refreshing = false; clearTimeout(timer); timer = setTimeout(refresh, shared && !studioClient.online ? 10000 : local ? 3000 : 10000); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ---------- Connexion ----------
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); token = $('token').value.trim(); $('token').value = ''; $('connect').disabled = true;
  try {
    if (shared) {
      const code = token; token = '';
      await studioClient.login(code);
      $('auth-message').textContent = ''; $('auth').hidden = true; $('open-auth').textContent = 'Mon accès';
      toast('Connecté ✓'); await refresh(); return;
    }
    if (!token) throw new Error('Renseigne ton token personnel GitHub.');
    const user = await request('https://api.github.com/user');
    if (user.login.toLowerCase() !== config.owner.toLowerCase()) throw new Error('Connecte le compte propriétaire du studio.');
    await request(`${repo()}/actions/workflows/${config.workflow}`);
    $('auth-message').textContent = ''; $('auth').hidden = true; $('open-auth').textContent = 'Compte'; $('open-auth').title = user.login;
    toast('Connecté ✓'); await refresh();
  } catch (error) { token = ''; $('auth-message').textContent = error.message; }
  finally { $('connect').disabled = false; }
});

// ---------- Lancement ----------
$('generate-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (mode !== 'generate' && !$('story').value) { $('form-message').textContent = 'Choisis une histoire.'; $('story').focus(); return; }
  const idea = $('idea').value.trim();
  busy = true; updateForm(); $('form-message').textContent = '';
  const input = { mode, story: mode === 'generate' ? '' : $('story').value, music: mode === 'check' ? '' : $('music').value, musicVolume: Number($('volume').value) / 100, creditLimit: Number($('budget').value) || 350, videoModel: selectedModel(),
    subtitles: $('subtitles').checked, ...(mode === 'generate' ? { style: selectedStyle(), idea } : {}) };
  try {
    let job;
    if (local) job = await request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    else {
      const id = crypto.randomUUID();
      await request(`${repo()}/actions/workflows/${config.workflow}/dispatches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: config.ref, inputs: {
        mode: input.mode, story: input.story, music: input.music, music_volume: String(input.musicVolume), credit_limit: String(input.creditLimit), request_id: id,
        style: input.style || 'fruits', idea: input.idea || '', subtitles: input.subtitles ? 'on' : 'off', video_model: input.videoModel } }) });
      job = { id, ...input, title: input.mode === 'generate' ? 'Nouvelle histoire' : dashboard.stories.find(s => s.id === input.story)?.title, status: 'queued', stage: 'story', percent: 0, createdAt: new Date().toISOString() };
      pending.unshift(job); store('workflowai-pending', pending);
    }
    dashboard.jobs.unshift(job);
    if (mode === 'generate') { $('idea').value = ''; $('idea-count').textContent = ''; try { sessionStorage.removeItem('workflowai-idea'); } catch {} }
    renderActivity(); tab('activity'); toast('C’est parti ✦ Le Mac s’en occupe.'); await refresh();
  } catch (error) { $('form-message').textContent = error.message; }
  finally { busy = false; updateForm(); }
});

// ---------- Import de musique ----------
$('import-button').addEventListener('click', () => $('music-file').click());
$('music-file').addEventListener('change', async () => {
  const file = $('music-file').files[0]; if (!file) return;
  $('upload-progress').hidden = false; $('upload-bar').value = 0;
  try {
    if (!/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024) throw new Error('Choisis un MP3, WAV, M4A, AAC, FLAC ou OGG de 20 Mo maximum.');
    busy = true; updateForm(); $('upload-message').textContent = 'Envoi de la musique…';
    if (local) {
      const imported = await request(`/api/music?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      recentImports.set(imported.name, Date.now());
      if (!dashboard.music.includes(imported.name)) dashboard.music.push(imported.name);
      selectedMusic = imported.name; fillChoices(); updateForm();
      $('upload-bar').value = 100; $('upload-message').textContent = `✓ ${imported.name} est prêt.`;
    } else {
      const id = crypto.randomUUID(), name = file.name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._ -]/g, '-').slice(-120).replace(/^\.+/, '');
      const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.onprogress = event => { if (event.lengthComputable) $('upload-bar').value = Math.round(event.loaded / event.total * 25); }; reader.readAsDataURL(file); });
      await request(`${repo()}/contents/uploads/${encodeURIComponent(id + '--' + name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: config.dataRef || 'studio-data', message: 'Import studio music', content }) });
      pendingImport = { id, name }; store('workflowai-import', pendingImport); $('upload-bar').value = 65; $('upload-message').textContent = 'Reçu. Le Mac vérifie la piste avant de la proposer.';
    }
    await refresh();
  } catch (error) { $('upload-message').textContent = error.message; }
  finally { busy = false; $('music-file').value = ''; updateForm(); }
});

// ---------- Démarrage ----------
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
    $('open-auth').textContent = 'Mon accès';
    if (connected()) { try { await studioClient.restore(); } catch (error) { toast(error.message); } }
  } else if (!local) {
    document.querySelector('label[for=token]').textContent = 'Token GitHub';
    $('token').placeholder = 'github_pat_…';
    $('auth-help').textContent = `Token « fine-grained » du compte ${config.owner}, limité au dépôt privé ${config.repository} : Actions et Contents en lecture/écriture. Il reste en mémoire dans cet onglet uniquement.`;
  }
  $('auth').hidden = connected(); $('open-auth').hidden = local && !shared;
  setMode('generate');
  if (connected()) await refresh(); else render();
} catch (error) { toast(error.message); }
