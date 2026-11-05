// AI SDLC Copilot - single page app (no build step).
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

const state = { user: null, permissions: null };

// ---------------- API ----------------
async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'sdlc-app' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`/api${path}`, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !path.startsWith('/auth/')) { state.user = null; location.hash = '#/login'; }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
}

let busyTimer;
function busy(title, steps) {
  const box = $('#busy');
  if (!title) { box.hidden = true; clearInterval(busyTimer); return; }
  $('#busy-title').textContent = title;
  $('#busy-steps').innerHTML = (steps || []).map((s) => `<li>${esc(s)}</li>`).join('');
  box.hidden = false;
  let i = 0;
  const lis = $$('#busy-steps li');
  const tick = () => { lis.forEach((li, k) => { li.className = k < i ? 'done' : k === i ? 'on' : ''; }); if (i < lis.length - 1) i++; };
  tick();
  clearInterval(busyTimer);
  busyTimer = setInterval(tick, 900);
}

async function guarded(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    const list = e.data?.errors;
    toast(list ? `${e.message}: ${list.join('; ')}` : e.message, 'error');
    return null;
  } finally {
    busy(null);
  }
}

function confirmDialog(title, bodyHtml, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<h3>${esc(title)}</h3><div class="stack">${bodyHtml}</div><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" value="no">Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" value="yes">${esc(okLabel)}</button></div>`;
    document.body.append(d);
    d.addEventListener('click', (e) => { if (e.target.value) { d.close(e.target.value); } });
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    d.showModal();
  });
}

// ---------------- Formatting helpers ----------------
const STAGES = ['requirements', 'architecture', 'tasks', 'tests'];
const STAGE_LABEL = { requirements: 'Requirements', architecture: 'Architecture', tasks: 'Dev Tasks', tests: 'QA Tests' };
const STAGE_GATE = { requirements: 'Gate 1 · Requirements review', architecture: 'Gate 2 · Architect approval', tasks: 'Gate 3 · Task review & assignment', tests: 'Gate 4 · QA approval' };
const STATUS_BADGE = { IN_REVIEW: 'blue', APPROVED: 'green', REJECTED: 'red', SUPERSEDED: '' };
const statusBadge = (s) => (s ? `<span class="badge ${STATUS_BADGE[s] || ''}">${esc(s.replace('_', ' '))}</span>` : '<span class="badge">NOT STARTED</span>');
const chips = (arr) => (arr || []).map((x) => `<span class="chip">${esc(x)}</span>`).join(' ');
const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="muted">-</span>');
const fmtDate = (s) => (s ? new Date(s.endsWith('Z') ? s : `${s.replace(' ', 'T')}Z`).toLocaleString() : '');
const sevClass = (s) => ({ High: 'red', high: 'red', Medium: 'amber', medium: 'amber', Low: '', low: '' }[s] ?? '');

// ---------------- Router ----------------
const routes = [
  [/^#\/login$/, viewLogin],
  [/^#\/register$/, viewRegister],
  [/^#\/projects$/, viewProjects],
  [/^#\/project\/(\d+)(?:\/(\w+))?$/, viewProject],
  [/^#\/admin(?:\/(\w+))?$/, viewAdmin],
  [/^#\/account$/, viewAccount],
];

async function router() {
  const hash = location.hash || '#/projects';
  if (!state.user && !['#/login', '#/register'].includes(hash)) {
    try {
      const me = await api('/auth/me');
      state.user = me.user;
      state.permissions = me.permissions;
    } catch { location.hash = '#/login'; return; }
  }
  renderTopbar(hash);
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) { await view(...m.slice(1)); app.focus({ preventScroll: true }); return; }
  }
  location.hash = '#/projects';
}
window.addEventListener('hashchange', router);

function renderTopbar(hash) {
  const bar = $('#topbar');
  if (!state.user || ['#/login', '#/register'].includes(hash)) { bar.hidden = true; return; }
  bar.hidden = false;
  const links = [['#/projects', 'Projects']];
  if (state.user.role === 'ADMIN') links.push(['#/admin', 'Administration']);
  $('#topnav').innerHTML = links.map(([h, l]) => `<a href="${h}" class="${hash.startsWith(h) ? 'active' : ''}">${l}</a>`).join('');
  $('#who').innerHTML = `<span class="badge violet">${esc(state.user.role)}</span><a href="#/account">${esc(state.user.name)}</a><button class="btn sm" id="logout">Sign out</button>`;
  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); state.user = null; location.hash = '#/login'; };
}

// ---------------- Auth views ----------------
function authShell(inner) {
  app.innerHTML = `<div class="auth-wrap"><div class="card auth">
    <div class="hero">
      <h1>AI SDLC Copilot</h1>
      <p>Requirements to architecture, dev tasks and QA test cases, with a human approving every stage.</p>
      <ul>
        <li>Upload Word requirements &amp; Excel team templates</li>
        <li>Multi-agent analysis: specialist, retrieval, critic &amp; guardrail agents</li>
        <li>4 human review gates with full audit trail</li>
        <li>Feedback agent regenerates with reviewer suggestions</li>
        <li>Export to Excel / CSV or push to Azure DevOps &amp; Jira</li>
      </ul>
    </div>
    <div class="form">${inner}</div></div></div>`;
}

function viewLogin() {
  authShell(`<h2>Sign in</h2>
    <form id="f" class="stack">
      <label class="field"><span>Email</span><input type="email" name="email" required autocomplete="username"></label>
      <label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn primary" style="width:100%;justify-content:center">Sign in</button>
      <p class="muted small">No account? <a href="#/register">Register</a> (an administrator activates new accounts).</p>
    </form>
    <hr>
    <div class="demo-users"><h4>Local demo accounts</h4>
      <div class="row">${['admin', 'pm', 'architect', 'dev', 'qa'].map((u) => `<button class="btn sm" data-u="${u}@demo.local">${u}</button>`).join('')}</div>
      <p class="muted small">Click to fill the email. Password is the <span class="mono">DEMO_PASSWORD</span> value in <span class="mono">.env</span>.</p>
    </div>`);
  $$('[data-u]').forEach((b) => { b.onclick = () => { $('[name=email]').value = b.dataset.u; $('[name=password]').focus(); }; });
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const r = await guarded(() => api('/auth/login', { method: 'POST', body: fd }));
    if (r) { state.user = null; location.hash = '#/projects'; }
  };
}

function viewRegister() {
  authShell(`<h2>Create account</h2>
    <form id="f" class="stack">
      <label class="field"><span>Full name</span><input type="text" name="name" required maxlength="80"></label>
      <label class="field"><span>Email</span><input type="email" name="email" required></label>
      <label class="field"><span>Requested role</span><select name="role"><option value="DEVELOPER">Developer</option><option value="QA">QA</option><option value="ARCHITECT">Software Architect</option><option value="PM">Project Manager</option></select></label>
      <label class="field"><span>Password (min 10 chars, letters + digits)</span><input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
      <button class="btn primary" style="width:100%;justify-content:center">Register</button>
      <p class="muted small"><a href="#/login">Back to sign in</a></p>
    </form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const r = await guarded(() => api('/auth/register', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }));
    if (r) { toast(r.message, 'ok'); location.hash = '#/login'; }
  };
}

function viewAccount() {
  app.innerHTML = `<div class="card" style="max-width:520px"><h2>My account</h2>
    <p>${esc(state.user.name)} · ${esc(state.user.email)} · <span class="badge violet">${esc(state.user.role)}</span></p><hr>
    <form id="f" class="stack"><h3>Change password</h3>
      <label class="field"><span>Current password</span><input type="password" name="currentPassword" required></label>
      <label class="field"><span>New password</span><input type="password" name="newPassword" required minlength="10"></label>
      <button class="btn primary">Update password</button></form></div>`;
  $('#f').onsubmit = async (e) => { e.preventDefault(); if (await guarded(() => api('/auth/change-password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }), 'Password updated')) e.target.reset(); };
}

// ---------------- Projects ----------------
async function viewProjects() {
  const projects = await api('/projects');
  const canCreate = ['PM', 'ADMIN'].includes(state.user.role);
  app.innerHTML = `<div class="row between"><h1>Projects</h1>${canCreate ? '<button class="btn primary" id="new">+ New project</button>' : ''}</div>
    ${projects.length ? `<div class="grid cols-3" style="margin-top:12px">${projects.map(projectCard).join('')}</div>` : `<div class="card empty">${canCreate ? 'No projects yet. Create one to start.' : 'You are not a member of any project yet. Ask your Project Manager to add you.'}</div>`}`;
  if (canCreate) $('#new').onclick = newProjectDialog;
}

function projectCard(p) {
  const w = p.workflow;
  const done = STAGES.filter((s) => w.stages[s].approvedVersion).length;
  return `<a class="card" href="#/project/${p.id}/overview" style="color:inherit;text-decoration:none">
    <div class="row between"><h3 style="margin:0">${esc(p.name)}</h3><span class="badge ${done === 4 ? 'green' : 'blue'}">${done}/4 gates</span></div>
    <p class="muted small" style="min-height:2.6em">${esc(p.description || 'No description')}</p>
    <div class="bar"><i style="width:${done * 25}%"></i></div>
    <div class="row small muted" style="margin-top:8px">${STAGES.map((s) => `${STAGE_LABEL[s]}: ${w.stages[s].approvedVersion ? '✓' : w.stages[s].latestStatus ? '…' : '–'}`).join(' · ')}</div></a>`;
}

async function newProjectDialog() {
  const dir = await api('/admin/directory');
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" id="pf" class="stack"><h3>New project</h3>
    <label class="field"><span>Name</span><input type="text" name="name" required maxlength="120" value="GlobalCommerce Express Checkout"></label>
    <label class="field"><span>Description</span><textarea name="description" maxlength="1000">AI-assisted SDLC for the Express Checkout feature.</textarea></label>
    <div class="field"><span class="small muted" style="font-weight:600">Team members (architect, developers, QA)</span>
      <div class="table-wrap" style="max-height:220px">${dir.filter((u) => u.id !== state.user.id).map((u) => `<label class="row" style="padding:6px 10px;border-bottom:1px solid var(--border)"><input type="checkbox" name="m" value="${u.id}" checked> ${esc(u.name)} <span class="badge">${esc(u.role)}</span></label>`).join('')}</div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Create</button></div></form>`;
  document.body.append(d);
  d.showModal();
  d.addEventListener('close', async () => {
    if (d.returnValue === 'ok') {
      const f = $('#pf', d);
      const body = { name: f.name.value, description: f.description.value, memberIds: $$('[name=m]:checked', f).map((c) => Number(c.value)) };
      const r = await guarded(() => api('/projects', { method: 'POST', body }), 'Project created');
      if (r) location.hash = `#/project/${r.id}/files`;
    }
    d.remove();
  });
}

// ---------------- Project shell ----------------
const TABS = [['overview', 'Overview'], ['files', 'Inputs'], ['requirements', '1 · Requirements'], ['architecture', '2 · Architecture'], ['tasks', '3 · Dev Tasks'], ['tests', '4 · QA Tests'], ['trace', 'Traceability'], ['export', 'Export & Integrations'], ['audit', 'Audit'], ['members', 'Members']];

async function viewProject(id, tab = 'overview') {
  const data = await api(`/projects/${id}`);
  state.project = data;
  const w = data.workflow;
  const stepState = (s) => {
    const st = w.stages[s];
    if (st.approvedVersion && st.latestStatus === 'APPROVED') return 'done';
    if (st.latestStatus === 'IN_REVIEW') return 'review';
    if (st.approvedVersion) return 'done';
    return st.canGenerate ? '' : 'blocked';
  };
  const stepDesc = (s) => {
    const st = w.stages[s];
    const bits = [];
    if (st.approvedVersion) bits.push(`<span class="badge green">v${st.approvedVersion} approved</span>`);
    if (st.latestStatus === 'IN_REVIEW') bits.push(`<span class="badge blue">v${st.latestVersion} in review</span>`);
    if (st.latestStatus === 'REJECTED') bits.push('<span class="badge red">rejected</span>');
    if (st.stale) bits.push('<span class="badge amber">stale</span>');
    if (!bits.length) bits.push(st.canGenerate ? '<span class="badge">ready</span>' : '<span class="badge">🔒 locked</span>');
    return bits.join(' ');
  };
  const filesDone = w.files.requirements && w.files.team;
  const tabs = TABS.filter(([t]) => (t !== 'audit' || state.user.role !== 'DEVELOPER') && (t !== 'export' || data.permissions.export));
  app.innerHTML = `
    <div class="row between"><div><a href="#/projects" class="small">← Projects</a><h1 style="margin-top:4px">${esc(data.project.name)}</h1></div>
      <span class="badge ${w.aiEnabled ? 'violet' : 'amber'}" title="AI engine">${w.aiEnabled ? '✦ ' : ''}${esc(w.engine)}</span></div>
    <div class="stepper" style="margin-top:8px">
      <a class="step ${filesDone ? 'done' : ''} ${tab === 'files' ? 'current' : ''}" href="#/project/${id}/files"><div class="n">Step 0</div><div class="t">Upload &amp; validate</div>${filesDone ? '<span class="badge green">files ready</span>' : '<span class="badge">pending</span>'}</a>
      ${STAGES.map((s, i) => `<a class="step ${stepState(s)} ${tab === s ? 'current' : ''}" href="#/project/${id}/${s}"><div class="n">Gate ${i + 1}</div><div class="t">${STAGE_LABEL[s]}</div>${stepDesc(s)}</a>`).join('')}
      <a class="step ${w.stages.tests.approvedVersion ? 'done' : ''} ${tab === 'export' ? 'current' : ''}" href="#/project/${id}/export"><div class="n">Deliver</div><div class="t">Export / ADO / Jira</div><span class="badge">${w.stages.tests.approvedVersion ? 'ready' : 'after approvals'}</span></a>
    </div>
    <nav class="tabs">${tabs.map(([t, l]) => `<a href="#/project/${id}/${t}" class="${t === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <section id="tab"></section>`;
  const el = $('#tab');
  if (tab === 'overview') return tabOverview(el, data);
  if (tab === 'files') return tabFiles(el, id);
  if (STAGES.includes(tab)) return tabStage(el, id, tab);
  if (tab === 'trace') return tabTrace(el, id);
  if (tab === 'export') return tabExport(el, id);
  if (tab === 'audit') return tabAudit(el, `/projects/${id}/audit`);
  if (tab === 'members') return tabMembers(el, id, data);
}

function tabOverview(el, data) {
  const w = data.workflow;
  const role = state.user.role;
  const next = [];
  if (!w.files.requirements || !w.files.team) next.push(['Upload the requirements (.docx) and team template (.xlsx)', 'files']);
  for (const s of STAGES) {
    const st = w.stages[s];
    if (st.canGenerate && !st.latestStatus && data.permissions[s].generate) next.push([`Generate ${STAGE_LABEL[s].toLowerCase()} with AI`, s]);
    if (st.latestStatus === 'IN_REVIEW' && data.permissions[s].approve) next.push([`Review & approve ${STAGE_LABEL[s].toLowerCase()} v${st.latestVersion}`, s]);
    if (st.stale) next.push([`${STAGE_LABEL[s]} is stale (upstream changed) - regenerate`, s]);
  }
  el.innerHTML = `<div class="grid cols-2">
    <div class="card"><h3>What's next for you (${esc(role)})</h3>
      ${next.length ? `<ul>${next.map(([t, tab]) => `<li><a href="#/project/${data.project.id}/${tab}">${esc(t)}</a></li>`).join('')}</ul>` : '<p class="muted">Nothing waiting on you right now.</p>'}
      ${!w.aiEnabled ? '<div class="alert warn small">Running on the <b>offline engine</b> (rule-based agents). Set <span class="mono">AZURE_OPENAI_ENDPOINT</span> and <span class="mono">AZURE_OPENAI_API_KEY</span> in <span class="mono">.env</span> to use the gpt-5-5 deployment.</div>' : ''}
    </div>
    <div class="card"><h3>How the agents work</h3>
      <ol class="small">
        <li><b>Orchestrator</b> routes each stage to a specialist and enforces approval gates.</li>
        <li><b>Retrieval agent</b> indexes the uploaded files and attaches evidence (📎) to each generated item.</li>
        <li><b>Specialist agents</b> (analyst → architect → planner → QA) draft each artefact.</li>
        <li><b>Critic agent</b> scores the output for gaps, traceability and consistency; low scores are auto-revised once (AI mode).</li>
        <li><b>Guardrail agent</b> redacts PII before the LLM, flags prompt injection, policy issues and unsupported claims.</li>
        <li><b>Feedback agent</b> regenerates a new version from reviewer suggestions, with a change log and diff.</li>
      </ol></div></div>
    <div class="grid cols-4" style="margin-top:16px">${STAGES.map((s) => { const st = w.stages[s]; return `<div class="card kpi"><div class="l">${STAGE_LABEL[s]}</div><div class="v">${st.criticScore ?? '–'}</div><div class="small muted">critic score · ${st.latestVersion ? `v${st.latestVersion}` : 'not generated'}</div></div>`; }).join('')}</div>`;
}

// ---------------- Inputs tab ----------------
async function tabFiles(el, id) {
  const data = await api(`/projects/${id}/files`);
  const can = state.project.permissions.upload;
  const card = (kind, title, ext, hint) => `<div class="card"><div class="row between"><h3>${title}</h3><span class="badge">${ext}</span></div>
    ${can ? `<label class="dropzone" data-kind="${kind}"><input type="file" accept="${ext}" hidden><b>Drop ${ext} here or click to browse</b><div class="small muted">${hint}</div></label>` : '<p class="muted small">Your role cannot upload files.</p>'}
    <div class="result" id="res-${kind}"></div>
    <h4 style="margin-top:14px">Versions</h4>
    ${versionTable(data.files.filter((f) => f.kind === kind))}</div>`;
  el.innerHTML = `<div class="grid cols-2">
      ${card('requirements', 'Requirements document', '.docx', 'Word document with FR / NFR sections, acceptance criteria. Max 10 MB, macros rejected.')}
      ${card('team', 'Team & project template', '.xlsx', 'Columns: Name, Role, Skills, Capacity (optional Email). Max 10 MB.')}
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h3>Team (latest)</h3>${data.team.length ? `<div class="table-wrap"><table><tr><th>Name</th><th>Role</th><th>Skills</th><th>Capacity h/wk</th></tr>${data.team.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.role)}</td><td>${chips(m.skills)}</td><td>${esc(m.capacity)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No team uploaded.</p>'}</div>
      <div class="card"><h3>Requirements preview</h3>${data.requirementsPreview ? `<p><b>${esc(data.requirementsPreview.title)}</b> · ${data.requirementsPreview.wordCount} words · IDs: ${chips(data.requirementsPreview.requirementIds)}</p><div style="max-height:300px;overflow:auto" class="small">${data.requirementsPreview.paragraphs.map((p) => `<p style="margin:4px 0">${esc(p)}</p>`).join('')}</div>` : '<p class="muted">No document uploaded.</p>'}</div>
    </div>`;
  $$('.dropzone', el).forEach((dz) => {
    const input = $('input', dz);
    const go = (file) => file && uploadFile(id, dz.dataset.kind, file);
    input.onchange = () => go(input.files[0]);
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); go(e.dataTransfer.files[0]); };
  });
}

function versionTable(rows) {
  if (!rows.length) return '<p class="muted small">No uploads yet.</p>';
  return `<div class="table-wrap"><table><tr><th>v</th><th>File</th><th>Uploaded</th><th>SHA-256</th><th>Checks</th></tr>${rows.map((f) => `<tr><td>${f.version}</td><td>${esc(f.original_name)}<div class="small muted">${(f.size / 1024).toFixed(1)} KB</div></td><td class="small">${esc(f.uploaded_by)}<br>${fmtDate(f.uploaded_at)}</td><td class="mono" title="${esc(f.sha256)}">${esc(f.sha256.slice(0, 12))}…</td><td>${f.validation?.warnings?.length ? `<span class="badge amber" title="${esc(f.validation.warnings.join('\n'))}">${f.validation.warnings.length} warning(s)</span>` : '<span class="badge green">passed</span>'}</td></tr>`).join('')}</table></div>`;
}

async function uploadFile(id, kind, file) {
  const fd = new FormData();
  fd.append('file', file);
  busy(`Validating ${file.name}`, ['Checking type, size & signature', 'Inspecting package structure & macros', 'Parsing content', 'Validating completeness', 'Storing securely (hashed, versioned)']);
  try {
    const r = await api(`/projects/${id}/files/${kind}`, { method: 'POST', form: fd });
    busy(null);
    toast(`Uploaded v${r.version}`, 'ok');
    await viewProject(id, 'files');
    const box = $(`#res-${kind}`);
    if (box && r.validation.warnings.length) box.innerHTML = `<div class="alert warn small" style="margin-top:10px"><b>Accepted with warnings</b><ul>${r.validation.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
  } catch (e) {
    busy(null);
    const box = $(`#res-${kind}`);
    if (box) box.innerHTML = `<div class="alert error small" style="margin-top:10px"><b>${esc(e.message)}</b>${e.data?.errors ? `<ul>${e.data.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
    toast(e.message, 'error');
  }
}

// ---------------- Stage tab ----------------
const S = (key, label, type = 'text', opts = {}) => ({ key, label, type, ...opts });
const SPECS = {
  requirements: {
    text: [S('summary', 'Summary', 'longtext')],
    sections: [
      { key: 'functional', title: 'Functional requirements', cols: [S('id', 'ID', 'id'), S('title', 'Title'), S('description', 'Description', 'longtext'), S('details', 'Flow / behaviour', 'list'), S('acceptanceCriteria', 'Acceptance criteria', 'list'), S('priority', 'Priority', 'select', { options: ['Must', 'Should', 'Could'] })] },
      { key: 'nonFunctional', title: 'Non-functional requirements', cols: [S('id', 'ID', 'id'), S('category', 'Category', 'select', { options: ['Performance', 'Security', 'Compliance', 'Availability', 'Scalability', 'Usability', 'Other'] }), S('title', 'Title'), S('description', 'Description', 'longtext'), S('metric', 'Metric')] },
      { key: 'constraints', title: 'Constraints', cols: [S('id', 'ID', 'id'), S('text', 'Constraint', 'longtext')] },
      { key: 'outOfScope', title: 'Out of scope', strings: true },
      { key: 'conflicts', title: '⚠ Conflicts (must be resolved before approval)', cols: [S('id', 'ID', 'id'), S('refs', 'Requirements', 'refs'), S('text', 'Conflict', 'longtext'), S('question', 'Decision needed', 'longtext')] },
      { key: 'ambiguities', title: 'Ambiguities & clarifying questions', cols: [S('id', 'ID', 'id'), S('ref', 'Ref'), S('text', 'Finding'), S('question', 'Question for product owner', 'longtext')] },
      { key: 'gaps', title: 'Gaps', cols: [S('id', 'ID', 'id'), S('ref', 'Ref'), S('text', 'Gap', 'longtext'), S('recommendation', 'Recommendation', 'longtext'), S('severity', 'Severity', 'select', { options: ['High', 'Medium', 'Low'] })] },
      { key: 'dependencies', title: 'Dependencies', cols: [S('id', 'ID', 'id'), S('name', 'Dependency'), S('type', 'Type', 'select', { options: ['External', 'Internal'] }), S('refs', 'Requirements', 'refs'), S('text', 'Notes')] },
      { key: 'risks', title: 'Risks', cols: [S('id', 'ID', 'id'), S('ref', 'Ref'), S('text', 'Risk', 'longtext'), S('severity', 'Severity', 'select', { options: ['High', 'Medium', 'Low'] }), S('mitigation', 'Mitigation', 'longtext')] },
      { key: 'assumptions', title: 'Assumptions', cols: [S('id', 'ID', 'id'), S('text', 'Assumption', 'longtext')] },
      { key: 'reviewerNotes', title: 'Reviewer directives', strings: true },
    ],
  },
  architecture: {
    text: [S('overview', 'Overview', 'longtext')],
    diagram: true,
    sections: [
      { key: 'components', title: 'Proposed components', cols: [S('id', 'ID', 'id'), S('name', 'Component'), S('category', 'Category', 'select', { options: ['Frontend', 'Backend', 'Database', 'Integration', 'Security', 'DevOps', 'Performance'] }), S('responsibility', 'Responsibility', 'longtext'), S('technology', 'Technology'), S('reqRefs', 'Requirements', 'refs')] },
      { key: 'interactions', title: 'System interactions', cols: [S('from', 'From'), S('to', 'To'), S('description', 'Interaction'), S('protocol', 'Protocol')] },
      { key: 'integrationPoints', title: 'Integration points', cols: [S('id', 'ID', 'id'), S('name', 'Name'), S('type', 'Type'), S('failureHandling', 'Failure handling', 'longtext'), S('reqRefs', 'Requirements', 'refs')] },
      { key: 'dataFlows', title: 'Data flows', cols: [S('id', 'ID', 'id'), S('name', 'Flow'), S('steps', 'Steps', 'list'), S('reqRefs', 'Requirements', 'refs')] },
      { key: 'technology', title: 'Technology considerations', cols: [S('area', 'Area'), S('choice', 'Choice'), S('rationale', 'Rationale', 'longtext')] },
      { key: 'security', title: 'Security considerations', cols: [S('id', 'ID', 'id'), S('concern', 'Concern'), S('control', 'Control', 'longtext'), S('reqRefs', 'Requirements', 'refs')] },
      { key: 'assumptions', title: 'Key assumptions', strings: true },
      { key: 'openQuestions', title: 'Open questions', strings: true },
      { key: 'reviewerNotes', title: 'Reviewer directives', strings: true },
    ],
  },
  tasks: {
    capacity: true,
    text: [S('sequencingNotes', 'Sequencing notes', 'longtext')],
    sections: [
      { key: 'tasks', title: 'Development tasks', cols: [S('id', 'ID', 'id'), S('sequence', '#', 'ro'), S('title', 'Task', 'longtext'), S('type', 'Type', 'select', { options: ['Backend', 'Frontend', 'DevOps', 'Security', 'Database', 'Integration', 'Performance'] }), S('reqRefs', 'Reqs', 'refs'), S('componentRef', 'Comp'), S('dependsOn', 'Depends on', 'refs'), S('skills', 'Skills', 'refs'), S('complexity', 'Size', 'select', { options: ['S', 'M', 'L', 'XL'] }), S('estimateHours', 'Hours', 'number'), S('priority', 'Priority', 'select', { options: ['P1', 'P2', 'P3'] }), S('assignee', 'Assignee', 'assignee', { roleFilter: /developer|devops|lead|engineer/i }), S('status', 'Status', 'select', { options: ['To Do', 'In Progress', 'Done', 'Blocked'] })] },
      { key: 'reviewerNotes', title: 'Reviewer directives', strings: true },
    ],
  },
  tests: {
    capacity: true,
    typeFilter: true,
    sections: [
      { key: 'testCases', title: 'Test cases', cols: [S('id', 'ID', 'id'), S('title', 'Title', 'longtext'), S('type', 'Type', 'select', { options: ['Positive', 'Negative', 'Boundary', 'Integration', 'Regression', 'Security', 'Usability', 'Performance'] }), S('reqRefs', 'Reqs', 'refs'), S('taskRefs', 'Tasks', 'refs'), S('preconditions', 'Preconditions', 'longtext'), S('steps', 'Steps', 'list'), S('expected', 'Expected result', 'longtext'), S('priority', 'Priority', 'select', { options: ['High', 'Medium', 'Low'] }), S('assignee', 'Assignee', 'assignee', { roleFilter: /qa|test/i }), S('status', 'Status', 'select', { options: ['Draft', 'Ready', 'Passed', 'Failed', 'Blocked'] })] },
      { key: 'reviewerNotes', title: 'Reviewer directives', strings: true },
    ],
  },
};

const stageUI = { editing: false, draft: null, typeFilter: 'All' };

async function tabStage(el, id, stage, version) {
  const data = await api(`/projects/${id}/stages/${stage}${version ? `?version=${version}` : ''}`);
  const { artifact: art, workflow, team, permissions: perm } = data;
  const st = workflow.stages[stage];
  stageUI.editing = false;
  stageUI.draft = null;
  const headerActions = [];
  if (perm.generate) headerActions.push(`<button class="btn ai" id="gen" ${st.canGenerate ? '' : 'disabled'} title="${esc(st.blockedReason || '')}">✦ ${art ? 'Regenerate from scratch' : `Generate ${STAGE_LABEL[stage]}`}</button>`);
  if (perm.edit && art) headerActions.push('<button class="btn" id="edit">✎ Edit</button>');

  if (!art) {
    el.innerHTML = `<div class="card empty"><h2>${STAGE_GATE[stage]}</h2>
      ${st.canGenerate ? `<p>Ready to generate. The orchestrator will run retrieval → specialist → critic → guardrail agents.</p>` : `<p>🔒 ${esc(st.blockedReason)}</p>`}
      <div class="row" style="justify-content:center">${headerActions.join('')}</div>
      ${!perm.generate ? `<p class="small">Your role (${esc(state.user.role)}) cannot generate this stage.</p>` : ''}</div>`;
    bindGenerate(el, id, stage);
    return;
  }
  const diff = art.changes?.diff || { added: [], modified: [], removed: [] };
  const rowClass = { added: new Set(diff.added.map((d) => d.id)), modified: new Set(diff.modified.map((d) => d.id)) };
  el.innerHTML = `
    <div class="stage-layout">
      <div>
        <div class="card" style="margin-bottom:16px">
          <div class="row between">
            <div class="row">
              <h2 style="margin:0">${STAGE_LABEL[stage]}</h2>
              <select id="ver" style="width:auto">${art.versions.map((v) => `<option value="${v.version}" ${v.version === art.version ? 'selected' : ''}>v${v.version} · ${v.status.replace('_', ' ').toLowerCase()} · ${v.source}</option>`).join('')}</select>
              ${statusBadge(art.status)} ${art.stale ? '<span class="badge amber" title="Upstream inputs changed after this version was generated">⚠ stale</span>' : ''}
            </div>
            <div class="row">${headerActions.join('')}</div>
          </div>
          <div class="small muted" style="margin-top:6px">${esc(STAGE_GATE[stage])} · created by ${esc(art.createdByName || '-')} ${fmtDate(art.createdAt)} · engine <span class="mono">${esc(art.engine)}</span> · source <span class="mono">${esc(art.source)}</span>${art.feedback ? ` · feedback: “${esc(art.feedback.slice(0, 120))}”` : ''}</div>
          ${art.changes?.note && art.changes.note.startsWith('AI service') ? `<div class="alert warn small" style="margin-top:8px">${esc(art.changes.note)}</div>` : ''}
        </div>
        <div id="edit-bar"></div>
        <div id="content">${renderContent(stage, art, team, rowClass)}</div>
      </div>
      <aside class="side stack">${renderSide(stage, art, perm, diff)}</aside>
    </div>`;
  if (SPECS[stage].diagram) renderDiagram(art.content);
  bindGenerate(el, id, stage);
  $('#ver').onchange = (e) => tabStage(el, id, stage, Number(e.target.value));
  bindTypeFilter(el, stage, art, team, rowClass);
  if ($('#edit')) $('#edit').onclick = () => startEdit(el, id, stage, art, team);
  bindSide(el, id, stage, art);
}

function bindGenerate(el, id, stage) {
  const btn = $('#gen', el);
  if (!btn) return;
  btn.onclick = async () => {
    busy(`Generating ${STAGE_LABEL[stage].toLowerCase()}`, ['Orchestrator: checking approval gates', 'Guardrail: scanning & redacting inputs', 'Retrieval: indexing approved files', `Specialist: drafting ${STAGE_LABEL[stage].toLowerCase()}`, 'Planner: sequencing & skill-based assignment', 'Critic: scoring gaps & traceability', 'Guardrail: checking output & claims', 'Saving version for human review']);
    const r = await guarded(() => api(`/projects/${id}/stages/${stage}/generate`, { method: 'POST' }), 'Generated - ready for review');
    if (r) viewProject(id, stage);
  };
}

function bindTypeFilter(el, stage, art, team, rowClass) {
  $$('.filters button', el).forEach((b) => {
    b.onclick = () => { stageUI.typeFilter = b.dataset.t; $('#content').innerHTML = renderContent(stage, art, team, rowClass); bindTypeFilter(el, stage, art, team, rowClass); };
  });
}

function evidenceIcon(art, itemId) {
  const ev = art.evidence?.[itemId];
  if (!ev?.length) return '';
  return `<span class="ev" title="${esc(ev.map((e) => `[${e.reqId || e.chunkId}] ${e.snippet}`).join('\n\n'))}">📎</span>`;
}

function cellView(col, v) {
  if (col.type === 'list') return list(v);
  if (col.type === 'refs') return chips(v);
  if (col.type === 'select' && ['High', 'Medium', 'Low'].includes(v)) return `<span class="badge ${sevClass(v)}">${esc(v)}</span>`;
  if (col.key === 'type' && v) return `<span class="badge blue">${esc(v)}</span>`;
  return esc(v ?? '');
}

function renderContent(stage, art, team, rowClass, editing = false) {
  const spec = SPECS[stage];
  const c = editing ? stageUI.draft : art.content;
  const parts = [];
  if (spec.capacity && c.capacity?.length) {
    parts.push(`<div class="capacity">${c.capacity.map((m) => { const pct = m.capacity ? Math.min(100, (m.assignedHours / m.capacity) * 100) : 0; return `<div class="cap"><b>${esc(m.name)}</b> <span class="small muted">${esc(m.role)}</span><div class="small">${m.assignedHours}h assigned · ${m.capacity}h/wk · <b>${m.weeksOfWork ?? '-'} wk</b></div><div class="bar ${m.weeksOfWork > 1 ? 'over' : ''}"><i style="width:${pct}%"></i></div></div>`; }).join('')}</div>`);
  }
  for (const t of spec.text || []) {
    parts.push(`<div class="card section"><h3>${t.label}</h3>${editing ? `<textarea data-text="${t.key}" rows="4">${esc(c[t.key])}</textarea>` : `<p style="margin:0;white-space:pre-wrap">${esc(c[t.key] || '-')}</p>`}</div>`);
  }
  if (spec.diagram) parts.push('<div class="card section"><h3>Component diagram</h3><div class="mermaid-box" id="diagram"><span class="muted small">Rendering…</span></div></div>');
  for (const sec of spec.sections) {
    let rows = c[sec.key] || [];
    if (!editing && !rows.length && sec.strings) continue;
    if (sec.strings) {
      parts.push(`<div class="card section"><div class="section-head"><h3 style="margin:0">${sec.title}</h3><span class="count">${rows.length}</span></div>${editing ? `<textarea data-strings="${sec.key}" rows="4" placeholder="One per line">${esc(rows.join('\n'))}</textarea>` : list(rows)}</div>`);
      continue;
    }
    let filterHtml = '';
    if (spec.typeFilter && !editing) {
      const types = ['All', ...new Set(rows.map((r) => r.type))];
      filterHtml = `<div class="filters">${types.map((t) => `<button data-t="${esc(t)}" class="${stageUI.typeFilter === t ? 'on' : ''}">${esc(t)} ${t === 'All' ? rows.length : rows.filter((r) => r.type === t).length}</button>`).join('')}</div>`;
      if (stageUI.typeFilter !== 'All') rows = rows.filter((r) => r.type === stageUI.typeFilter);
    }
    const cols = sec.cols;
    const head = `<tr>${cols.map((col) => `<th>${col.label}</th>`).join('')}${editing ? '<th></th>' : ''}</tr>`;
    const body = rows.map((r, i) => {
      const cls = rowClass.added.has(r.id) ? 'row-added' : rowClass.modified.has(r.id) ? 'row-modified' : '';
      const cells = cols.map((col) => {
        if (!editing || col.type === 'ro') return `<td class="${col.type === 'id' ? 'id' : ''}">${cellView(col, r[col.key])}${col.type === 'id' ? evidenceIcon(art, r.id) : ''}${col.key === 'assignee' && r.assignmentReason ? `<div class="small muted" title="${esc(r.assignmentReason)}">ⓘ why</div>` : ''}</td>`;
        return `<td class="edit">${editor(col, r[col.key], sec.key, i, team)}</td>`;
      }).join('');
      return `<tr class="${cls}">${cells}${editing ? `<td><button class="btn sm danger" data-del="${sec.key}:${i}" title="Remove row">✕</button></td>` : ''}</tr>`;
    }).join('');
    parts.push(`<div class="card section"><div class="section-head"><h3 style="margin:0">${sec.title}</h3><span class="count">${(c[sec.key] || []).length}</span><span class="spacer"></span>${editing ? `<button class="btn sm" data-add="${sec.key}">+ Add row</button>` : ''}</div>${filterHtml}
      ${rows.length ? `<div class="table-wrap" style="max-height:640px"><table>${head}${body}</table></div>` : '<p class="muted small">None.</p>'}</div>`);
  }
  return parts.join('');
}

function editor(col, v, sec, i, team) {
  const at = `data-sec="${sec}" data-i="${i}" data-k="${col.key}" data-type="${col.type}"`;
  if (col.type === 'select') return `<select ${at}>${[...new Set([...(col.options || []), v].filter(Boolean))].map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (col.type === 'assignee') {
    const people = team.filter((m) => col.roleFilter.test(m.role));
    return `<select ${at}><option value="">— unassigned —</option>${people.map((m) => `<option ${m.name === v ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`;
  }
  if (col.type === 'number') return `<input type="number" min="0" ${at} value="${esc(v)}" style="width:70px">`;
  if (col.type === 'list') return `<textarea ${at} rows="3" placeholder="One per line">${esc((v || []).join('\n'))}</textarea>`;
  if (col.type === 'refs') return `<input type="text" ${at} value="${esc((v || []).join(', '))}" placeholder="comma separated">`;
  if (col.type === 'longtext') return `<textarea ${at} rows="2">${esc(v)}</textarea>`;
  return `<input type="text" ${at} value="${esc(v)}">`;
}

function collectDraft() {
  const d = stageUI.draft;
  $$('#content [data-sec]').forEach((inp) => {
    const { sec, i, k, type } = inp.dataset;
    const row = d[sec][Number(i)];
    if (!row) return;
    const v = inp.value;
    row[k] = type === 'list' ? v.split('\n').map((s) => s.trim()).filter(Boolean)
      : type === 'refs' ? v.split(',').map((s) => s.trim()).filter(Boolean)
        : type === 'number' ? Number(v) || 0 : v;
  });
  $$('#content [data-text]').forEach((t) => { d[t.dataset.text] = t.value; });
  $$('#content [data-strings]').forEach((t) => { d[t.dataset.strings] = t.value.split('\n').map((s) => s.trim()).filter(Boolean); });
}

function startEdit(el, id, stage, art, team) {
  stageUI.editing = true;
  stageUI.draft = structuredClone(art.content);
  const empty = { added: new Set(), modified: new Set() };
  const rerender = () => {
    $('#content').innerHTML = renderContent(stage, art, team, empty, true);
    $$('[data-add]').forEach((b) => { b.onclick = () => { collectDraft(); const sec = SPECS[stage].sections.find((s) => s.key === b.dataset.add); const row = {}; for (const col of sec.cols) row[col.key] = ['list', 'refs'].includes(col.type) ? [] : ''; const prefix = { tasks: 'T', testCases: 'TC', components: 'C', security: 'S', risks: 'R', gaps: 'G', ambiguities: 'A', assumptions: 'AS', functional: 'FR', nonFunctional: 'NFR', integrationPoints: 'IP', dataFlows: 'DF', constraints: 'CON', dependencies: 'D' }[sec.key]; if (prefix) row.id = `${prefix}-NEW${stageUI.draft[sec.key].length + 1}`; stageUI.draft[sec.key].push(row); rerender(); }; });
    $$('[data-del]').forEach((b) => { b.onclick = () => { collectDraft(); const [sec, i] = b.dataset.del.split(':'); stageUI.draft[sec].splice(Number(i), 1); rerender(); }; });
  };
  $('#edit-bar').innerHTML = `<div class="alert info row between" style="margin-bottom:12px"><span><b>Editing.</b> Saving creates a new version that goes back into review (critic &amp; guardrail re-run).</span>
    <span class="row"><input type="text" id="edit-comment" placeholder="Reason for change (audited)" style="width:260px"><button class="btn" id="cancel-edit">Cancel</button><button class="btn primary" id="save-edit">Save as new version</button></span></div>`;
  rerender();
  $('#cancel-edit').onclick = () => tabStage(el, id, stage, art.version);
  $('#save-edit').onclick = async () => {
    collectDraft();
    const r = await guarded(() => api(`/projects/${id}/stages/${stage}`, { method: 'PUT', body: { content: stageUI.draft, comment: $('#edit-comment').value } }), 'Saved new version');
    if (r) viewProject(id, stage);
  };
}

async function renderDiagram(content) {
  const box = $('#diagram');
  if (!box) return;
  if (!window.mermaid) { box.innerHTML = '<span class="muted small">Diagram library unavailable offline.</span>'; return; }
  const clean = (s) => String(s || '').replace(/["[\]{}()<>|#;]/g, ' ').slice(0, 40);
  const ids = new Set(content.components.map((c) => c.id));
  const nid = (s) => String(s).replace(/[^A-Za-z0-9]/g, '_');
  const shape = { Database: ['[(', ')]'], Frontend: ['([', '])'], Integration: ['[[', ']]'] };
  const lines = ['flowchart LR'];
  for (const c of content.components) { const [a, b] = shape[c.category] || ['[', ']']; lines.push(`  ${nid(c.id)}${a}"${clean(c.name)}"${b}`); }
  for (const i of content.interactions) if (ids.has(i.from) && ids.has(i.to)) lines.push(`  ${nid(i.from)} -->|${clean(i.protocol)}| ${nid(i.to)}`);
  try {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
    const { svg } = await window.mermaid.render(`m${Date.now()}`, lines.join('\n'));
    box.innerHTML = svg;
  } catch (e) {
    box.innerHTML = `<pre class="json">${esc(lines.join('\n'))}</pre>`;
  }
}

function renderSide(stage, art, perm, diff) {
  const c = art.critic || { score: 0, issues: [] };
  const color = c.score >= 85 ? 'var(--accent)' : c.score >= 60 ? 'var(--amber)' : 'var(--red)';
  const g = art.guardrail || { input: [], output: [] };
  const gAll = [...(g.input || []), ...(g.output || [])];
  const high = gAll.filter((f) => f.severity === 'high');
  const log = art.changes?.changeLog || [];
  const isReviewable = art.status === 'IN_REVIEW';
  const hint = {
    requirements: 'resolve X-01: video consultation moves to Phase 2\nresolve A-05: 30 is inclusive\nadd risk: FraudGuard SLA unknown for FR-102\nadd assumption: OTP valid for 5 minutes',
    architecture: 'use PostgreSQL instead of Azure SQL\nadd component: Feature flag service for FR-101\nadd security control: WAF in front of the gateway for FR-101',
    tasks: 'assign T-014 to Asha\npriority of T-022 to P1\nestimate T-017 to 24\nadd task: Feature toggle for express checkout FR-101',
    tests: 'add test: Negative - expired OTP rejected for FR-102\nassign TC-031 to Arjun\nremove TC-006',
  }[stage];
  return `
    <div class="card"><h4>Critic agent</h4>
      <div class="score"><div class="gauge" style="--v:${c.score};--c:${color}">${c.score}</div><div><b>${esc(c.verdict || '')}</b><div class="small muted">${esc(c.summary || '')}</div></div></div>
      ${c.issues.length ? `<ul class="issues">${c.issues.map((i) => `<li><span class="sev ${i.severity}"></span><span>${esc(i.message)} <span class="small muted">${esc(i.category)}${i.source === 'ai' ? ' · AI' : ''}</span></span></li>`).join('')}</ul>` : '<p class="small muted">No issues found.</p>'}
      ${art.changes?.selfRevision ? `<div class="alert info small" style="margin-top:8px">Self-revised automatically (score was ${art.changes.selfRevision.scoreBefore}).</div>` : ''}
    </div>
    <div class="card"><h4>Governance &amp; guardrails</h4>
      ${gAll.length ? `<ul class="issues">${gAll.map((f) => `<li><span class="sev ${f.severity}"></span><span><b>${esc(f.type)}</b> · ${esc(f.where)}${f.sample ? ` · <span class="mono">${esc(f.sample)}</span>` : ''}${f.concern ? `<div class="small muted">${esc(f.concern)}</div>` : ''}</span></li>`).join('')}</ul>` : '<p class="small"><span class="badge green">✓ passed</span> No sensitive data, injection attempts or unsupported claims detected.</p>'}
    </div>
    ${log.length || diff.added.length || diff.modified.length || diff.removed.length ? `<div class="card"><h4>Changes in this version</h4>
      <div class="row small"><span class="badge green">+${diff.added.length} added</span><span class="badge amber">~${diff.modified.length} modified</span><span class="badge red">−${diff.removed.length} removed</span></div>
      ${log.length ? `<ul class="small" style="padding-left:18px;margin:8px 0 0">${log.map((l) => `<li><b>${esc(l.change)}</b>${l.reason ? `<div class="muted">${esc(l.reason)}</div>` : ''}</li>`).join('')}</ul>` : ''}
      ${diff.removed.length ? `<div class="small muted" style="margin-top:6px">Removed: ${diff.removed.map((d) => esc(d.id)).join(', ')}</div>` : ''}</div>` : ''}
    <div class="card"><h4>${esc(STAGE_GATE[stage])}</h4>
      ${isReviewable ? `
        <textarea id="rv-comment" rows="3" placeholder="Review comments (required to reject)"></textarea>
        ${high.length || art.content.conflicts?.length ? `<label class="row small" style="margin-top:6px"><input type="checkbox" id="rv-ack"> I have reviewed ${[high.length && `${high.length} high-severity guardrail finding(s)`, art.content.conflicts?.length && `${art.content.conflicts.length} unresolved conflict(s)`].filter(Boolean).join(' and ')}</label>` : ''}
        <div class="row" style="margin-top:8px">
          ${perm.approve ? '<button class="btn primary" id="rv-approve">✓ Approve</button><button class="btn danger" id="rv-reject">✕ Reject</button>' : `<span class="small muted">Only ${stage === 'architecture' ? 'the Software Architect' : 'authorised reviewers'} can approve.</span>`}
          <button class="btn" id="rv-comment-btn">Comment</button>
        </div>
        ${art.stale ? '<div class="alert warn small" style="margin-top:8px">Upstream inputs changed - regenerate before approval.</div>' : ''}`
    : `<p class="small">This version is ${statusBadge(art.status)}. ${art.status === 'APPROVED' ? 'Downstream stages are unlocked.' : ''}</p><button class="btn sm" id="rv-comment-btn">Add comment</button><textarea id="rv-comment" rows="2" placeholder="Comment"></textarea>`}
      ${art.reviews.length ? `<h4 style="margin-top:12px">History</h4><ul class="issues">${art.reviews.map((r) => `<li><span class="badge ${{ APPROVED: 'green', REJECTED: 'red', REGENERATE: 'violet' }[r.decision] || ''}">${esc(r.decision)}</span><span class="small"><b>${esc(r.reviewer_name)}</b> · ${fmtDate(r.created_at)}${r.comments ? `<div>${esc(r.comments)}</div>` : ''}</span></li>`).join('')}</ul>` : ''}
    </div>
    ${perm.edit ? `<div class="card"><h4>✦ Review-feedback agent</h4>
      <p class="small muted" style="margin-top:0">Describe changes in plain language. A new version is generated from v${art.version}, with a change log and diff.</p>
      <textarea id="fb-text" rows="5" placeholder="${esc(hint)}"></textarea>
      <label class="row small" style="margin-top:6px"><input type="checkbox" id="fb-critic" checked> Also fix the critic's findings</label>
      <button class="btn ai" id="fb-go" style="margin-top:8px;width:100%;justify-content:center">✦ Regenerate with feedback</button>
      <details class="small" style="margin-top:8px"><summary>Example instructions</summary><pre class="json">${esc(hint)}</pre></details>
    </div>` : ''}`;
}

function bindSide(el, id, stage, art) {
  const comment = () => $('#rv-comment')?.value.trim() || '';
  const decide = async (decision) => {
    if (decision === 'APPROVED' && !(await confirmDialog(`Approve ${STAGE_LABEL[stage]} v${art.version}?`, `<p>This records your identity, timestamp and comments, and unlocks the next stage.</p>`, 'Approve'))) return;
    const r = await guarded(() => api(`/projects/${id}/stages/${stage}/versions/${art.version}/decision`, { method: 'POST', body: { decision, comments: comment(), acknowledgeRisks: $('#rv-ack')?.checked } }), decision === 'COMMENT' ? 'Comment added' : `Version ${decision.toLowerCase()}`);
    if (r) viewProject(id, stage);
  };
  if ($('#rv-approve')) $('#rv-approve').onclick = () => decide('APPROVED');
  if ($('#rv-reject')) $('#rv-reject').onclick = () => decide('REJECTED');
  if ($('#rv-comment-btn')) $('#rv-comment-btn').onclick = () => decide('COMMENT');
  if ($('#fb-go')) {
    $('#fb-go').onclick = async () => {
      const feedback = $('#fb-text').value.trim();
      const addressCritic = $('#fb-critic').checked;
      if (!feedback && !addressCritic) return toast('Enter feedback or tick "fix critic findings"', 'error');
      busy('Regenerating with your feedback', ['Guardrail: scanning feedback', 'Feedback agent: applying suggestions', 'Resolving critic findings', 'Re-balancing assignments', 'Critic: re-scoring', 'Computing diff vs previous version']);
      const r = await guarded(() => api(`/projects/${id}/stages/${stage}/regenerate`, { method: 'POST', body: { baseVersion: art.version, feedback, addressCritic } }), 'New version generated from feedback');
      if (r) viewProject(id, stage);
    };
  }
}

// ---------------- Traceability ----------------
async function tabTrace(el, id) {
  const t = await api(`/projects/${id}/traceability`);
  if (!t.rows.length) { el.innerHTML = '<div class="card empty">Generate requirements first.</div>'; return; }
  const s = t.summary;
  el.innerHTML = `<div class="grid cols-4">
      <div class="card kpi"><div class="l">Requirements</div><div class="v">${s.requirements}</div></div>
      <div class="card kpi"><div class="l">With dev tasks</div><div class="v">${s.withTasks}</div></div>
      <div class="card kpi"><div class="l">With test cases</div><div class="v">${s.withTests}</div></div>
      <div class="card kpi"><div class="l">Fully traced</div><div class="v" style="color:${s.fullyCovered === s.requirements ? 'var(--accent)' : 'var(--amber)'}">${Math.round((s.fullyCovered / s.requirements) * 100)}%</div></div></div>
    <div class="card" style="margin-top:16px"><h3>Requirement → component → task → test matrix</h3>
    <div class="table-wrap"><table><tr><th>Requirement</th><th>Components</th><th>Dev tasks</th><th>Test cases</th><th>Test types</th><th>Status</th></tr>
    ${t.rows.map((r) => `<tr><td class="id">${esc(r.reqId)}<div class="small muted" style="font-family:inherit;font-weight:400">${esc(r.title)}</div></td><td>${chips(r.components)}</td><td>${chips(r.tasks)}</td><td>${chips(r.tests)}</td><td>${r.testTypes.map((x) => `<span class="badge blue">${esc(x)}</span>`).join(' ')}</td><td>${r.covered ? '<span class="badge green">traced</span>' : '<span class="badge red">gap</span>'}</td></tr>`).join('')}
    </table></div></div>`;
}

// ---------------- Export & integrations ----------------
async function tabExport(el, id) {
  const canIntegrate = state.project.permissions.integrate;
  const integ = canIntegrate ? await api(`/projects/${id}/integrations`) : {};
  const dl = (fmt, label, desc) => `<a class="card" style="display:block;color:inherit" href="/api/projects/${id}/export/${fmt}${$('#approved-only')?.checked ? '?approvedOnly=true' : ''}" data-fmt="${fmt}"><b>${label}</b><div class="small muted">${desc}</div></a>`;
  const mapText = (m) => Object.entries(m || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  const ado = integ.ado?.config || {};
  const jira = integ.jira?.config || {};
  el.innerHTML = `
    <div class="card"><div class="row between"><h3 style="margin:0">Download</h3><label class="row small"><input type="checkbox" id="approved-only"> Approved versions only</label></div>
      <div class="grid cols-4" style="margin-top:12px" id="dl">
        ${dl('xlsx', '📊 Excel workbook', 'Requirements, analysis, architecture, tasks, tests, traceability & approvals')}
        ${dl('jira-csv', '🟦 Jira CSV', 'For Jira “External system import” (Epics, Stories, Tasks)')}
        ${dl('ado-csv', '🔷 Azure DevOps CSV', 'For Boards → Import work items (with hierarchy)')}
        ${dl('md', '📝 Markdown report', 'Readable summary for wikis / PRs')}
        ${dl('json', '{ } JSON bundle', 'Full machine-readable export')}
      </div></div>
    ${canIntegrate ? `<div class="grid cols-2" style="margin-top:16px">
      <div class="card" id="ado-card"><div class="row between"><h3 style="margin:0">Azure DevOps Boards</h3>${integ.ado ? `<span class="badge green">configured · ${integ.ado.synced} synced</span>` : '<span class="badge">not configured</span>'}</div>
        <form class="stack" style="margin-top:10px" data-type="ado">
          <div class="grid cols-2" style="grid-template-columns:1fr 1fr"><label class="field"><span>Organization</span><input type="text" name="organization" value="${esc(ado.organization)}" placeholder="my-org"></label>
          <label class="field"><span>Project</span><input type="text" name="project" value="${esc(ado.project)}" placeholder="NFTS-Bootcamp-Team01"></label></div>
          <div class="grid cols-2" style="grid-template-columns:1fr 1fr"><label class="field"><span>Area path (optional)</span><input type="text" name="areaPath" value="${esc(ado.areaPath)}"></label>
          <label class="field"><span>Iteration path (optional)</span><input type="text" name="iterationPath" value="${esc(ado.iterationPath)}"></label></div>
          <label class="field"><span>Requirement work item type</span><select name="reqType">${['User Story', 'Product Backlog Item', 'Requirement', 'Feature'].map((t) => `<option ${ado.workItemTypes?.requirement === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="field"><span>Personal Access Token ${integ.ado?.hasSecret ? '(saved, encrypted - leave blank to keep)' : ''}</span><input type="password" name="secret" autocomplete="off" placeholder="Work Items: Read &amp; Write scope"></label>
          <label class="field"><span>Assignee map (team name = ADO email), optional</span><textarea name="map" rows="2" placeholder="Asha Rao = asha@contoso.com">${esc(mapText(ado.assigneeMap))}</textarea></label>
        </form></div>
      <div class="card" id="jira-card"><div class="row between"><h3 style="margin:0">Jira Cloud</h3>${integ.jira ? `<span class="badge green">configured · ${integ.jira.synced} synced</span>` : '<span class="badge">not configured</span>'}</div>
        <form class="stack" style="margin-top:10px" data-type="jira">
          <label class="field"><span>Site URL</span><input type="url" name="baseUrl" value="${esc(jira.baseUrl)}" placeholder="https://your-team.atlassian.net"></label>
          <div class="grid cols-2" style="grid-template-columns:1fr 1fr"><label class="field"><span>Account email</span><input type="email" name="email" value="${esc(jira.email)}"></label>
          <label class="field"><span>Project key</span><input type="text" name="projectKey" value="${esc(jira.projectKey)}" placeholder="ECX"></label></div>
          <div class="grid cols-2" style="grid-template-columns:1fr 1fr"><label class="field"><span>Requirement issue type</span><select name="reqType">${['Epic', 'Story'].map((t) => `<option ${jira.issueTypes?.requirement === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="field"><span>Test case issue type</span><select name="testType">${['Task', 'Test', 'Story', 'Bug'].map((t) => `<option ${jira.issueTypes?.test === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
          <label class="field"><span>API token ${integ.jira?.hasSecret ? '(saved, encrypted - leave blank to keep)' : ''}</span><input type="password" name="secret" autocomplete="off"></label>
          <label class="field"><span>Assignee map (team name = Jira accountId), optional</span><textarea name="map" rows="2">${esc(mapText(jira.assigneeMap))}</textarea></label>
        </form></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="row between"><h3 style="margin:0">Push approved outputs</h3>
      <div class="row small">${['requirements', 'tasks', 'tests'].map((s) => `<label class="row"><input type="checkbox" name="scope" value="${s}" checked> ${STAGE_LABEL[s]}</label>`).join('')}</div></div>
      <p class="small muted">Only <b>approved</b> versions are pushed. Re-pushing skips items already created (idempotent). Use <b>Dry run</b> to preview exact payloads without sending anything.</p>
      <div class="row">${['ado', 'jira'].map((t) => `<span class="row" style="padding:6px 10px;border:1px solid var(--border);border-radius:8px"><b>${t === 'ado' ? 'Azure DevOps' : 'Jira'}</b><button class="btn sm" data-act="save" data-t="${t}">Save</button><button class="btn sm" data-act="test" data-t="${t}">Test connection</button><button class="btn sm" data-act="dry" data-t="${t}">Dry run</button><button class="btn sm primary" data-act="push" data-t="${t}">Push</button></span>`).join('')}</div>
      <div id="push-result" style="margin-top:12px"></div></div>` : '<div class="alert info" style="margin-top:16px">Integrations with Azure DevOps and Jira are configured by Project Managers.</div>'}`;
  $('#approved-only').onchange = () => { $$('#dl a').forEach((a) => { a.href = `/api/projects/${id}/export/${a.dataset.fmt}${$('#approved-only').checked ? '?approvedOnly=true' : ''}`; }); };
  if (!canIntegrate) return;
  const readForm = (t) => {
    const f = $(`form[data-type=${t}]`);
    const map = Object.fromEntries(f.map.value.split('\n').map((l) => l.split('=').map((s) => s.trim())).filter((p) => p[0] && p[1]));
    const cfg = t === 'ado'
      ? { organization: f.organization.value, project: f.project.value, areaPath: f.areaPath.value, iterationPath: f.iterationPath.value, workItemTypes: { requirement: f.reqType.value }, assigneeMap: map }
      : { baseUrl: f.baseUrl.value, email: f.email.value, projectKey: f.projectKey.value, issueTypes: { requirement: f.reqType.value, test: f.testType.value }, assigneeMap: map };
    return { config: cfg, secret: f.secret.value || undefined };
  };
  const scope = () => $$('[name=scope]:checked').map((c) => c.value);
  const out = $('#push-result');
  $$('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const t = b.dataset.t;
      const act = b.dataset.act;
      if (act === 'save') { if (await guarded(() => api(`/projects/${id}/integrations/${t}`, { method: 'PUT', body: readForm(t) }), 'Integration saved (token encrypted at rest)')) tabExport(el, id); return; }
      if (act === 'test') { const r = await guarded(() => api(`/projects/${id}/integrations/${t}/test`, { method: 'POST' })); if (r) toast(r.message, r.ok ? 'ok' : 'error'); return; }
      if (act === 'dry') {
        const r = await guarded(() => api(`/projects/${id}/integrations/${t}/push`, { method: 'POST', body: { scope: scope(), dryRun: true } }));
        if (r) out.innerHTML = `<div class="alert info small"><b>Dry run:</b> ${r.count} work item(s) would be created in ${t === 'ado' ? 'Azure DevOps' : 'Jira'}. Nothing was sent.</div>
          <div class="table-wrap" style="max-height:300px;margin-top:8px"><table><tr><th>Local ID</th><th>Kind</th><th>Type</th><th>Title</th><th>Links</th></tr>${r.plan.map((p) => `<tr><td class="id">${esc(p.localId)}</td><td>${esc(p.kind)}</td><td>${esc(p.workItemType || p.fields?.issuetype?.name)}</td><td>${esc(p.ops ? p.ops.find((o) => o.path === '/fields/System.Title')?.value : p.fields.summary)}</td><td class="small">${esc((p.links || []).map((l) => `${l.rel || l.type}→${l.target || l.blocker}`).join(', '))}${p.parent ? ` parent→${esc(p.parent)}` : ''}</td></tr>`).join('')}</table></div>
          <details style="margin-top:8px"><summary>First payload</summary><pre class="json">${esc(JSON.stringify(r.plan[0], null, 2))}</pre></details>`;
        return;
      }
      if (act === 'push') {
        if (!(await confirmDialog(`Push to ${t === 'ado' ? 'Azure DevOps' : 'Jira'}?`, `<p>This creates real work items for the approved ${scope().join(', ')} in the configured project. Items already pushed are skipped.</p>`, 'Push now'))) return;
        busy(`Pushing to ${t === 'ado' ? 'Azure DevOps' : 'Jira'}`, ['Building work items from approved versions', 'Creating parent items', 'Creating tasks & test cases', 'Linking dependencies']);
        const r = await guarded(() => api(`/projects/${id}/integrations/${t}/push`, { method: 'POST', body: { scope: scope(), dryRun: false } }));
        if (r) {
          toast(`Created ${r.summary.created}, skipped ${r.summary.skipped}, failed ${r.summary.failed}`, r.summary.failed ? 'error' : 'ok');
          out.innerHTML = `<div class="table-wrap" style="max-height:340px"><table><tr><th>Local ID</th><th>Status</th><th>External</th></tr>${r.results.map((x) => `<tr><td class="id">${esc(x.localId)}</td><td><span class="badge ${x.status === 'created' ? 'green' : x.status === 'skipped' ? '' : 'red'}">${esc(x.status)}</span></td><td class="small">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.externalId)}</a>` : esc(x.error || '')}</td></tr>`).join('')}</table></div>`;
        }
      }
    };
  });
}

// ---------------- Audit ----------------
async function tabAudit(el, path) {
  const rows = await api(path);
  el.innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">Audit trail</h3><div class="row"><input type="text" id="af" placeholder="Filter (action, user, entity)" style="width:260px"><button class="btn sm" id="acsv">Export CSV</button></div></div>
    <div class="table-wrap" style="margin-top:10px;max-height:70vh"><table id="at"></table></div></div>`;
  const draw = (q = '') => {
    const f = rows.filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
    $('#at').innerHTML = `<tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th></tr>${f.map((r) => `<tr><td class="small" style="white-space:nowrap">${fmtDate(r.ts)}</td><td class="small">${esc(r.user_email || '-')}</td><td><span class="badge ${/DENIED|REJECT|FAILED|BLOCKED|LOCKED/.test(r.action) ? 'red' : /APPROVED|LOGIN$/.test(r.action) ? 'green' : /AI_/.test(r.action) ? 'violet' : ''}">${esc(r.action)}</span></td><td class="mono">${esc([r.entity, r.entity_id].filter(Boolean).join(' '))}</td><td class="mono" style="max-width:520px;word-break:break-word">${esc(r.details_json || '')}</td></tr>`).join('')}`;
  };
  draw();
  $('#af').oninput = (e) => draw(e.target.value);
  $('#acsv').onclick = () => {
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
    const csv = ['ts,user,action,entity,entity_id,details', ...rows.map((r) => [r.ts, r.user_email, r.action, r.entity, r.entity_id, r.details_json].map(cell).join(','))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'audit-log.csv';
    a.click();
  };
}

// ---------------- Members ----------------
async function tabMembers(el, id, data) {
  const can = data.permissions.manageMembers;
  const dir = can ? await api('/admin/directory') : [];
  const memberIds = new Set(data.members.map((m) => m.id));
  el.innerHTML = `<div class="card" style="max-width:820px"><h3>Project members</h3>
    <div class="table-wrap"><table><tr><th>Name</th><th>Email</th><th>Role</th>${can ? '<th></th>' : ''}</tr>${data.members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td><span class="badge">${esc(m.role)}</span></td>${can ? `<td>${m.id !== state.user.id ? `<button class="btn sm danger" data-rm="${m.id}">Remove</button>` : ''}</td>` : ''}</tr>`).join('')}</table></div>
    ${can ? `<div class="row" style="margin-top:12px"><select id="addm" style="max-width:360px">${dir.filter((u) => !memberIds.has(u.id)).map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`).join('')}</select><button class="btn primary" id="addb">Add member</button></div>` : ''}
    <p class="small muted">Access to project files, outputs and workflows is restricted to members. Role permissions: PM → upload, tasks, exports; Architect → architecture approval; QA → test approval; Developer → read &amp; comment.</p></div>`;
  if (!can) return;
  if ($('#addb')) $('#addb').onclick = async () => { if (await guarded(() => api(`/projects/${id}/members`, { method: 'POST', body: { userId: Number($('#addm').value) } }), 'Member added')) viewProject(id, 'members'); };
  $$('[data-rm]').forEach((b) => { b.onclick = async () => { if (await guarded(() => api(`/projects/${id}/members/${b.dataset.rm}`, { method: 'DELETE' }), 'Member removed')) viewProject(id, 'members'); }; });
}

// ---------------- Admin ----------------
async function viewAdmin(tab = 'users') {
  if (state.user.role !== 'ADMIN') { location.hash = '#/projects'; return; }
  app.innerHTML = `<h1>Administration</h1><nav class="tabs"><a href="#/admin/users" class="${tab === 'users' ? 'active' : ''}">Users</a><a href="#/admin/audit" class="${tab === 'audit' ? 'active' : ''}">Global audit</a></nav><section id="tab"></section>`;
  const el = $('#tab');
  if (tab === 'audit') return tabAudit(el, '/admin/audit');
  const users = await api('/admin/users');
  const roles = ['ADMIN', 'PM', 'ARCHITECT', 'DEVELOPER', 'QA'];
  el.innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">Users</h3><button class="btn primary" id="nu">+ Create user</button></div>
    <div class="table-wrap" style="margin-top:10px"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><select data-role="${u.id}" style="width:auto">${roles.map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td>${u.active ? '<span class="badge green">active</span>' : '<span class="badge amber">pending / inactive</span>'} ${u.locked_until && new Date(u.locked_until) > new Date() ? '<span class="badge red">locked</span>' : ''}</td><td class="small">${fmtDate(u.created_at)}</td>
      <td class="row"><button class="btn sm" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Deactivate' : 'Activate'}</button><button class="btn sm" data-unlock="${u.id}">Unlock</button><button class="btn sm" data-reset="${u.id}">Reset password</button></td></tr>`).join('')}</table></div></div>`;
  const patch = async (id, body, msg) => { if (await guarded(() => api(`/admin/users/${id}`, { method: 'PATCH', body }), msg)) viewAdmin('users'); };
  $$('[data-role]').forEach((s) => { s.onchange = () => patch(s.dataset.role, { role: s.value }, 'Role updated'); });
  $$('[data-toggle]').forEach((b) => { b.onclick = () => patch(b.dataset.toggle, { active: b.dataset.active !== '1' }, 'Status updated'); });
  $$('[data-unlock]').forEach((b) => { b.onclick = () => patch(b.dataset.unlock, { unlock: true }, 'Unlocked'); });
  $$('[data-reset]').forEach((b) => {
    b.onclick = async () => {
      const pw = prompt('New temporary password (min 10 chars, letters + digits):');
      if (pw) await guarded(() => api(`/admin/users/${b.dataset.reset}/reset-password`, { method: 'POST', body: { password: pw } }), 'Password reset');
    };
  });
  $('#nu').onclick = async () => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog" class="stack" id="uf"><h3>Create user</h3>
      <label class="field"><span>Name</span><input type="text" name="name" required></label>
      <label class="field"><span>Email</span><input type="email" name="email" required></label>
      <label class="field"><span>Role</span><select name="role">${roles.map((r) => `<option>${r}</option>`).join('')}</select></label>
      <label class="field"><span>Initial password</span><input type="password" name="password" required minlength="10"></label>
      <div class="row" style="justify-content:flex-end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Create</button></div></form>`;
    document.body.append(d);
    d.showModal();
    d.addEventListener('close', async () => {
      if (d.returnValue === 'ok') { const body = Object.fromEntries(new FormData($('#uf', d))); if (await guarded(() => api('/admin/users', { method: 'POST', body }), 'User created')) viewAdmin('users'); }
      d.remove();
    });
  };
}

router();
