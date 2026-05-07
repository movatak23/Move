const API = (() => {
  const BASE = '/api';

  function getToken() { return localStorage.getItem('token'); }
  function getUser() { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } }

  function headers() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
  }

  async function request(method, path, body) {
    const opts = { method, headers: headers() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(BASE + path, opts);
    if (res.status === 401) { logout(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/index.html';
  }

  function guardAuth() {
    const user = getUser();
    if (!user || !getToken()) { logout(); return null; }
    return user;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    getUser, getToken, logout, guardAuth
  };
})();

function fmtBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
}

function fmtData(d) {
  if (!d) return '-';
  const [a, m, dia] = d.split('T')[0].split('-');
  return `${dia}/${m}/${a}`;
}

function tipoBadge(tipo) {
  if (!tipo) return '';
  if (tipo.includes('ATIVAÇÃO')) return `<span class="badge badge-green">ATIVAÇÃO</span>`;
  if (tipo === 'RECARGA') return `<span class="badge badge-accent">RECARGA</span>`;
  return `<span class="badge badge-yellow">${tipo}</span>`;
}

function showAlert(msg, type = 'error', containerId = 'alert-area') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 4000);
}

function showModal(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = html;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}
