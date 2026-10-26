// Only the studio's own device credential is persisted. No GitHub token or access code.
export class StudioAuthError extends Error {}
export class StudioConnectionError extends Error {}
export function validBackend(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === 'https:' && /\.(lhr\.life|trycloudflare\.com)$/.test(url.hostname) || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  } catch { return false; }
}
export class StudioClient {
  constructor({ base, storage, legacyStorage, fetcher = fetch, now = () => Date.now(), configURL = 'config.json', repository = 'mamoune123/workFlowAI-studio' }) {
    this.base = base || ''; this.storage = storage; this.legacyStorage = legacyStorage; this.fetcher = fetcher; this.now = now;
    this.configURL = configURL; this.repository = repository; this.online = false; this.discoveryAt = -Infinity; this.publicDiscoveryAt = -Infinity; this.discoveryCount = 0;
    try { this.device = storage.getItem('workflowai-device') || ''; } catch { this.device = ''; }
    try { this.access = legacyStorage?.getItem('workflowai-session') || ''; } catch { this.access = ''; }
  }
  get connected() { return Boolean(this.device || this.access); }
  save(credentials) {
    this.access = credentials.token;
    if (credentials.deviceToken) { this.device = credentials.deviceToken; this.storage.setItem('workflowai-device', this.device); }
    this.legacyStorage?.removeItem('workflowai-session');
  }
  forget() {
    this.access = ''; this.device = '';
    this.storage.removeItem('workflowai-device'); this.legacyStorage?.removeItem('workflowai-session');
  }
  async discover() {
    if (!this.base || this.now() - this.discoveryAt < 5000) return false;
    this.discoveryAt = this.now();
    const accept = value => {
      if (validBackend(value?.apiBase) && value.apiBase !== this.base) { this.base = value.apiBase.replace(/\/$/, ''); return true; }
      return false;
    };
    try {
      const response = await this.fetcher(`${this.configURL}?reconnect=${this.now()}`, { cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) });
      if (response.ok && accept(await response.json())) return true;
    } catch {}
    if (this.now() - this.publicDiscoveryAt < (this.discoveryCount < 3 ? 15000 : 180000)) return false;
    this.publicDiscoveryAt = this.now();
    this.discoveryCount++;
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/contents/public/config.json?ref=main&reconnect=${this.now()}`, {
        cache: 'no-store', headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const entry = await response.json();
        const decoded = new TextDecoder().decode(Uint8Array.from(atob(entry.content.replace(/\s/g, '')), c => c.charCodeAt(0)));
        return accept(JSON.parse(decoded));
      }
    } catch {}
    return false;
  }
  async raw(resource, options = {}, credential = this.access, retry = true) {
    const method = (options.method || 'GET').toUpperCase();
    const safeRetry = method === 'GET' || ['/api/session', '/api/session/refresh', '/api/session/remember'].includes(resource);
    let response;
    try {
      response = await this.fetcher(this.base + resource, { ...options, cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: options.signal || AbortSignal.timeout(resource === '/api/music' ? 300000 : 20000),
        headers: { ...options.headers, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      });
      if ([502, 503, 504].includes(response.status)) { await response.body?.cancel(); throw new StudioConnectionError(); }
    } catch {
      this.online = false;
      await this.discover();
      if (retry && safeRetry) return this.raw(resource, options, credential, false);
      throw new StudioConnectionError(method === 'GET' || safeRetry
        ? 'Le serveur se reconnecte. Ton accès est conservé ; la page réessaie automatiquement.'
        : 'Connexion interrompue. La demande n’a pas été renvoyée automatiquement : vérifie son état dans Suivi avant de réessayer.');
    }
    this.online = true;
    this.discoveryCount = 0;
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (response.status === 401) throw new StudioAuthError(data?.error || 'Cet accès a été déconnecté. Saisis le code du studio.');
    if (!response.ok) throw new Error(data?.error || `Le studio a répondu ${response.status}.`);
    return data;
  }
  async login(code) {
    const credentials = await this.raw('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }, '');
    this.save(credentials);
  }
  async restore() {
    if (this.restoring) return this.restoring;
    this.restoring = (async () => {
      if (!this.connected) return false;
      try {
        const credentials = this.device
          ? await this.raw('/api/session/refresh', { method: 'POST' }, this.device)
          : await this.raw('/api/session/remember', { method: 'POST' }, this.access);
        this.save(credentials); return true;
      } catch (error) {
        if (error instanceof StudioAuthError) this.forget();
        throw error;
      }
    })();
    try { return await this.restoring; } finally { this.restoring = null; }
  }
  async request(resource, options = {}) {
    if (!this.access && this.device) await this.restore();
    try { return await this.raw(resource, options); }
    catch (error) {
      if (!(error instanceof StudioAuthError)) throw error;
      if (!this.device) { this.forget(); throw error; }
      await this.restore();
      return this.raw(resource, options);
    }
  }
  async logout() {
    const device = this.device;
    try { if (device) await this.raw('/api/session/logout', { method: 'POST' }, device, false); }
    finally { this.forget(); }
  }
}
