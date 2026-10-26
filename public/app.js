const $ = id => document.getElementById(id);
const stages = ['story', 'images', 'videos', 'assembly', 'subtitles', 'music', 'split', 'done'];
const labels = ['Écriture de l’histoire', 'Création des images', 'Génération des vidéos', 'Assemblage', 'Application des sous-titres', 'Mixage de la musique', 'Découpage en trois parties', 'Livraison prête'];
let local = false, config, token = '', current, timer, started;
const message = text => { $('form-message').textContent = text; };
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...options.headers, ...(token && url.startsWith('https://api.github.com/') ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : {}) }, cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error('Accès refusé. Vérifie le token, les permissions Actions et l’accès au dépôt privé.');
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || body.message || `Erreur HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}
const repoAPI = () => `https://api.github.com/repos/${config.owner}/${config.repository}`;
let catalogAt = 0;
async function loadCatalog() {
  if (Date.now() - catalogAt < 10000) return;
  try {
    let data;
    if (local) data = await api('/api/config');
    else {
      if (!token) return;
      const entry = await api(`${repoAPI()}/contents/studio-catalog.json?ref=${encodeURIComponent(config.ref)}`);
      data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(entry.content.replace(/\s/g, '')), c => c.charCodeAt(0))));
    }
    for (const [id, values] of [['music-list', data.music], ['stories', data.stories]]) {
      $(id).replaceChildren();
      for (const name of values || []) { const option = document.createElement('option'); option.value = name; $(id).append(option); }
    }
    catalogAt = Date.now();
  } catch { /* A stale/missing catalogue never submits an unvalidated filename. */ }
}
$('music').addEventListener('focus', loadCatalog);
$('story').addEventListener('focus', loadCatalog);
function updateFields() {
  $('story-field').hidden = $('mode').value === 'generate';
  $('budget-field').hidden = ['finish', 'check'].includes($('mode').value);
  $('story').required = $('mode').value !== 'generate';
}
$('mode').addEventListener('change', updateFields);
$('volume').addEventListener('input', () => { $('volume-value').textContent = `${$('volume').value} %`; });
$('connect').addEventListener('click', async () => {
  token = $('token').value.trim(); $('token').value = '';
  try {
    if (!token) throw new Error('Renseigne un token personnel GitHub.');
    const user = await api('https://api.github.com/user');
    if (user.login.toLowerCase() !== config.owner.toLowerCase()) { token = ''; throw new Error('Connecte le compte propriétaire du pipeline.'); }
    await api(`${repoAPI()}/actions/workflows/${config.workflow}`);
    await loadCatalog();
    $('auth-status').textContent = `Connecté : ${user.login}. Token conservé jusqu’à la fermeture de cet onglet.`;
    $('connection').textContent = 'GITHUB CONNECTÉ'; $('generate').disabled = false;
    if (current) monitor();
  } catch (error) { token = ''; $('auth-status').textContent = error.message; }
});
function showProgress(status, stage, error) {
  $('empty-state').hidden = true; $('progress').hidden = false;
  const index = stages.indexOf(stage);
  $('job-status').textContent = ({ complete: 'TERMINÉ', completed: 'TERMINÉ', running: 'EN COURS', in_progress: 'EN COURS', queued: 'EN ATTENTE', failed: 'ARRÊTÉ' })[status] || status;
  $('current-stage').textContent = status === 'queued' ? 'En attente du Mac connecté à Chrome' : labels[index] || 'Pipeline en cours';
  $('progress-bar').style.width = `${status === 'complete' ? 100 : Math.max(3, (index + 1) / 8 * 100)}%`;
  document.querySelectorAll('[data-stage]').forEach(el => { const i = stages.indexOf(el.dataset.stage); el.classList.toggle('active', i === index); el.classList.toggle('done', i < index); });
  $('job-message').textContent = error || '';
  $('generate').disabled = !['complete', 'completed', 'failed', 'cancelled'].includes(status);
  if (started) $('elapsed').textContent = `${Math.floor((Date.now() - started) / 60000)} min`;
}
function finishPolling() { clearTimeout(timer); timer = null; }
function remember() { try { sessionStorage.setItem('workflowai-job', JSON.stringify(current)); } catch {} }
async function monitor() {
  finishPolling();
  try {
    if (local) {
      const job = await api(`/api/jobs/${current.id}`);
      started = Date.parse(job.startedAt || job.createdAt);
      showProgress(job.status, job.stage, job.error);
      if (job.status === 'complete') {
        for (const part of job.parts || []) {
          $(`part-${part.part}-detail`).textContent = `${part.scenes} scènes · ${Math.round(part.duration)} s`;
          const link = $(`part-${part.part}-link`); link.hidden = false; link.href = `/outputs/${job.id}/${part.file}`;
        }
        return;
      }
      if (job.status === 'failed') return;
    } else {
      if (!token) return;
      if (!current.runId) {
        const data = await api(`${repoAPI()}/actions/workflows/${config.workflow}/runs?event=workflow_dispatch&per_page=30`);
        const run = data.workflow_runs.find(r => r.display_title.includes(current.id));
        if (run) { current.runId = run.id; current.url = run.html_url; remember(); }
      }
      if (current.runId) {
        const run = await api(`${repoAPI()}/actions/runs/${current.runId}`);
        $('run-link').hidden = false; $('run-link').href = run.html_url;
        started = Date.parse(run.created_at);
        // GitHub exposes job/step progress, while the detailed stages stay in the private run log.
        const complete = run.status === 'completed', success = run.conclusion === 'success';
        showProgress(complete ? success ? 'complete' : 'failed' : run.status, complete && success ? 'done' : null, complete && !success ? `Pipeline ${run.conclusion}. Consulte le journal GitHub pour reprendre.` : complete ? '' : 'Le Mac exécute le pipeline. Le détail est disponible sur GitHub.');
        if (complete) {
          if (success && current.mode !== 'check') { $('archive').hidden = false; $('archive-link').href = run.html_url + '#artifacts'; }
          return;
        }
      } else showProgress('queued', 'story');
    }
    timer = setTimeout(monitor, local ? 3000 : 10000);
  } catch (error) { message(error.message); $('generate').disabled = false; }
}
$('generate-form').addEventListener('submit', async event => {
  event.preventDefault(); message(''); $('generate').disabled = true;
  for (let i = 1; i <= 3; i++) $(`part-${i}-link`).hidden = true;
  $('archive').hidden = true;
  const input = { mode: $('mode').value, story: $('story').value.trim(), music: $('music').value.trim(), musicVolume: Number($('volume').value) / 100, creditLimit: Number($('budget').value) };
  try {
    if (local) { const job = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); current = { id: job.id, mode: input.mode }; }
    else {
      if (!token) throw new Error('Connecte GitHub pour lancer une génération.');
      current = { id: crypto.randomUUID(), mode: input.mode };
      await api(`${repoAPI()}/actions/workflows/${config.workflow}/dispatches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: config.ref, inputs: { mode: input.mode, story: input.story, music: input.music, music_volume: String(input.musicVolume), credit_limit: String(input.creditLimit), request_id: current.id } }) });
    }
    remember(); started = Date.now(); showProgress('queued', 'story'); monitor();
  } catch (error) { message(error.message); $('generate').disabled = false; }
});
try {
  // Relative paths work on both localhost and a GitHub Pages project URL.
  config = await api('config.json');
  try { const response = await fetch('/api/config', { cache: 'no-store' }); if (response.ok && response.headers.get('content-type')?.includes('application/json')) { config = await response.json(); local = config.mode === 'local'; } } catch {}
  if (local) {
    $('connection').textContent = 'MAC LOCAL';
    for (const name of config.stories) { const o = document.createElement('option'); o.value = name; $('stories').append(o); }
    for (const name of config.music) { const o = document.createElement('option'); o.value = name; $('music-list').append(o); }
    $('story').value = config.stories[0] || '';
  } else { $('github-auth').hidden = false; $('generate').disabled = true; $('connection').textContent = 'CONNEXION GITHUB'; }
  try { current = JSON.parse(sessionStorage.getItem('workflowai-job')); } catch {}
  if (current && local) monitor();
  updateFields();
} catch (error) { message(error.message); }
