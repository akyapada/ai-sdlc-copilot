// Push approved outputs to Azure DevOps Boards or Jira Cloud.
// Supports dry-run (shows exact payloads, sends nothing) and idempotent re-push via sync_items.

import net from 'node:net';
import { db } from '../db.js';
import { config } from '../config.js';
import { approvedArtifact } from '../agents/orchestrator.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (lines) => lines.filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('');

export function validateConfig(type, cfg) {
  const errors = [];
  if (type === 'ado') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(cfg.organization || '')) errors.push('Organization is required (letters, digits, . _ -)');
    if (!cfg.project || cfg.project.length > 128 || /[\\/:*?"<>|#%]/.test(cfg.project)) errors.push('Valid ADO project name is required');
  } else {
    let u;
    try { u = new URL(cfg.baseUrl); } catch { errors.push('Jira base URL must be a valid URL'); }
    if (u) {
      if (u.protocol !== 'https:') errors.push('Jira base URL must use https');
      const h = u.hostname.toLowerCase();
      const privateHost = h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || (net.isIP(h) && /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|::1|fc|fd)/.test(h));
      if (privateHost && !config.allowPrivateIntegrationHosts) errors.push('Private / local Jira hosts are blocked (set ALLOW_PRIVATE_INTEGRATION_HOSTS=true for on-prem)');
    }
    if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(cfg.projectKey || '')) errors.push('Jira project key must be upper-case (e.g. ECX)');
    if (!/^\S+@\S+\.\S+$/.test(cfg.email || '')) errors.push('Jira account email is required');
  }
  return errors;
}

function approvedItems(projectId, scope) {
  const req = approvedArtifact(projectId, 'requirements')?.content;
  const tasks = approvedArtifact(projectId, 'tasks')?.content?.tasks;
  const tests = approvedArtifact(projectId, 'tests')?.content?.testCases;
  const missing = [];
  if (scope.includes('requirements') && !req) missing.push('requirements');
  if (scope.includes('tasks') && !tasks) missing.push('tasks');
  if (scope.includes('tests') && !tests) missing.push('tests');
  return {
    missing,
    requirements: scope.includes('requirements') ? [...(req?.functional || []), ...(req?.nonFunctional || [])] : [],
    tasks: scope.includes('tasks') ? tasks || [] : [],
    tests: scope.includes('tests') ? tests || [] : [],
  };
}

// ---------------- Azure DevOps ----------------
function adoTestSteps(t) {
  const steps = t.steps.length ? t.steps : ['Execute test'];
  const body = steps.map((s, i) => `<step id="${i + 2}" type="${i === steps.length - 1 ? 'ValidateStep' : 'ActionStep'}"><parameterizedString isformatted="true">${esc(esc(s))}</parameterizedString><parameterizedString isformatted="true">${i === steps.length - 1 ? esc(esc(t.expected)) : ''}</parameterizedString><description/></step>`).join('');
  return `<steps id="0" last="${steps.length + 1}">${body}</steps>`;
}

function adoPlan(cfg, items) {
  const types = { requirement: 'User Story', task: 'Task', test: 'Test Case', ...(cfg.workItemTypes || {}) };
  const assignee = (name) => cfg.assigneeMap?.[name];
  const common = (tags) => [
    { op: 'add', path: '/fields/System.Tags', value: tags },
    ...(cfg.areaPath ? [{ op: 'add', path: '/fields/System.AreaPath', value: cfg.areaPath }] : []),
    ...(cfg.iterationPath ? [{ op: 'add', path: '/fields/System.IterationPath', value: cfg.iterationPath }] : []),
  ];
  const plan = [];
  for (const r of items.requirements) {
    plan.push({ localId: r.id, kind: 'requirement', workItemType: types.requirement, links: [], ops: [
      { op: 'add', path: '/fields/System.Title', value: `${r.id} ${r.title}`.slice(0, 255) },
      { op: 'add', path: '/fields/System.Description', value: html([r.description, ...(r.details || []), r.metric && `Metric: ${r.metric}`]) },
      ...(r.acceptanceCriteria?.length ? [{ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: `<ul>${r.acceptanceCriteria.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` }] : []),
      ...common(`ai-sdlc; requirement; ${r.category || 'functional'}`),
    ] });
  }
  for (const t of items.tasks) {
    plan.push({ localId: t.id, kind: 'task', workItemType: types.task,
      links: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', target: t.reqRefs[0] }, ...t.dependsOn.map((d) => ({ rel: 'System.LinkTypes.Dependency-Reverse', target: d }))],
      ops: [
        { op: 'add', path: '/fields/System.Title', value: `${t.id} ${t.title}`.slice(0, 255) },
        { op: 'add', path: '/fields/System.Description', value: html([t.description, `Skills: ${t.skills.join(', ')}`, `Complexity: ${t.complexity}`, `Suggested assignee: ${t.assignee || '-'}`, ...(t.acceptanceCriteria || []).map((a) => `AC: ${a}`)]) },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: { P1: 1, P2: 2, P3: 3 }[t.priority] || 2 },
        { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: Number(t.estimateHours) || 0 },
        ...(assignee(t.assignee) ? [{ op: 'add', path: '/fields/System.AssignedTo', value: assignee(t.assignee) }] : []),
        ...common(`ai-sdlc; dev-task; ${t.type}`),
      ] });
  }
  for (const t of items.tests) {
    plan.push({ localId: t.id, kind: 'test', workItemType: types.test,
      links: t.reqRefs.map((r) => ({ rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', target: r })),
      ops: [
        { op: 'add', path: '/fields/System.Title', value: `${t.id} [${t.type}] ${t.title}`.slice(0, 255) },
        { op: 'add', path: '/fields/System.Description', value: html([`Preconditions: ${t.preconditions || '-'}`, `Tasks: ${t.taskRefs.join(', ')}`]) },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: adoTestSteps(t) },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: t.priority === 'High' ? 1 : t.priority === 'Low' ? 3 : 2 },
        ...(assignee(t.assignee) ? [{ op: 'add', path: '/fields/System.AssignedTo', value: assignee(t.assignee) }] : []),
        ...common(`ai-sdlc; test-case; ${t.type}`),
      ] });
  }
  return plan;
}

async function adoPush(cfg, pat, plan, synced, record) {
  const base = `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/${encodeURIComponent(cfg.project)}`;
  const auth = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  const idMap = { ...synced };
  const results = [];
  let consecutiveFailures = 0;
  for (const p of plan) {
    if (idMap[p.localId]) { results.push({ localId: p.localId, status: 'skipped', externalId: idMap[p.localId].id, url: idMap[p.localId].url }); continue; }
    const relOps = p.links.filter((l) => idMap[l.target]).map((l) => ({ op: 'add', path: '/relations/-', value: { rel: l.rel, url: `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/_apis/wit/workItems/${idMap[l.target].id}` } }));
    try {
      const res = await fetch(`${base}/_apis/wit/workitems/$${encodeURIComponent(p.workItemType)}?api-version=7.1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json-patch+json', Authorization: auth },
        body: JSON.stringify([...p.ops, ...relOps]),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const wi = await res.json();
      const url = wi._links?.html?.href || `${base}/_workitems/edit/${wi.id}`;
      idMap[p.localId] = { id: String(wi.id), url };
      record(p.localId, String(wi.id), url);
      results.push({ localId: p.localId, status: 'created', externalId: String(wi.id), url });
      consecutiveFailures = 0;
    } catch (e) {
      results.push({ localId: p.localId, status: 'failed', error: e.message });
      if (++consecutiveFailures >= 3) { results.push({ localId: '-', status: 'aborted', error: 'Stopped after 3 consecutive failures (check PAT / work item types)' }); break; }
    }
  }
  return results;
}

// ---------------- Jira Cloud ----------------
const adf = (lines) => ({ type: 'doc', version: 1, content: lines.filter(Boolean).map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: String(l).slice(0, 5000) }] })) });
const label = (s) => String(s).replace(/\s+/g, '-').toLowerCase();

function jiraPlan(cfg, items) {
  const types = { requirement: 'Epic', task: 'Task', test: 'Task', ...(cfg.issueTypes || {}) };
  const fields = (summary, type, description, labels, extra = {}) => ({ project: { key: cfg.projectKey }, summary: summary.slice(0, 254), issuetype: { name: type }, description: adf(description), labels: labels.map(label), ...extra });
  const plan = [];
  for (const r of items.requirements) {
    plan.push({ localId: r.id, kind: 'requirement', parentOf: null, links: [], fields: fields(`${r.id} ${r.title}`, types.requirement, [r.description, ...(r.details || []), ...(r.acceptanceCriteria || []).map((a) => `AC: ${a}`), r.metric && `Metric: ${r.metric}`], ['ai-sdlc', 'requirement']) });
  }
  for (const t of items.tasks) {
    plan.push({ localId: t.id, kind: 'task', parent: t.reqRefs[0], links: t.dependsOn.map((d) => ({ type: 'Blocks', blocker: d })), assignee: cfg.assigneeMap?.[t.assignee],
      fields: fields(`${t.id} ${t.title}`, types.task, [t.description, `Estimate: ${t.estimateHours}h (${t.complexity})`, `Skills: ${t.skills.join(', ')}`, `Suggested assignee: ${t.assignee || '-'}`, `Requirements: ${t.reqRefs.join(', ')}`, ...(t.acceptanceCriteria || []).map((a) => `AC: ${a}`)], ['ai-sdlc', 'dev-task', t.type]) });
  }
  for (const t of items.tests) {
    plan.push({ localId: t.id, kind: 'test', parent: t.reqRefs[0], links: t.taskRefs.map((d) => ({ type: 'Relates', blocker: d })), assignee: cfg.assigneeMap?.[t.assignee],
      fields: fields(`${t.id} [${t.type}] ${t.title}`, types.test, [`Preconditions: ${t.preconditions || '-'}`, ...t.steps.map((s, i) => `${i + 1}. ${s}`), `Expected: ${t.expected}`, `Requirements: ${t.reqRefs.join(', ')}`], ['ai-sdlc', 'test-case', t.type]) });
  }
  return plan;
}

async function jiraPush(cfg, token, plan, synced, record) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}` };
  const idMap = { ...synced };
  const results = [];
  const pendingLinks = [];
  let consecutiveFailures = 0;
  for (const p of plan) {
    if (idMap[p.localId]) { results.push({ localId: p.localId, status: 'skipped', externalId: idMap[p.localId].id, url: idMap[p.localId].url }); continue; }
    const f = { ...p.fields };
    if (p.parent && idMap[p.parent] && cfg.useParent !== false) f.parent = { key: idMap[p.parent].id };
    if (p.assignee) f.assignee = { accountId: p.assignee };
    try {
      const res = await fetch(`${base}/rest/api/3/issue`, { method: 'POST', headers, body: JSON.stringify({ fields: f }), signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const issue = await res.json();
      const url = `${base}/browse/${issue.key}`;
      idMap[p.localId] = { id: issue.key, url };
      record(p.localId, issue.key, url);
      results.push({ localId: p.localId, status: 'created', externalId: issue.key, url });
      for (const l of p.links) pendingLinks.push({ from: p.localId, ...l });
      consecutiveFailures = 0;
    } catch (e) {
      results.push({ localId: p.localId, status: 'failed', error: e.message });
      if (++consecutiveFailures >= 3) { results.push({ localId: '-', status: 'aborted', error: 'Stopped after 3 consecutive failures (check token / issue types)' }); break; }
    }
  }
  for (const l of pendingLinks) {
    if (!idMap[l.blocker] || !idMap[l.from]) continue;
    try {
      const body = { type: { name: l.type }, outwardIssue: { key: idMap[l.blocker].id }, inwardIssue: { key: idMap[l.from].id } };
      const res = await fetch(`${base}/rest/api/3/issueLink`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      if (!res.ok) results.push({ localId: `${l.from}<-${l.blocker}`, status: 'link-failed', error: `HTTP ${res.status}` });
    } catch (e) {
      results.push({ localId: `${l.from}<-${l.blocker}`, status: 'link-failed', error: e.message });
    }
  }
  return results;
}

// ---------------- Public API ----------------
export function buildPlan(type, cfg, projectId, scope) {
  const items = approvedItems(projectId, scope);
  if (items.missing.length) {
    const err = new Error(`Only approved outputs can be pushed. Not yet approved: ${items.missing.join(', ')}`);
    err.status = 409;
    throw err;
  }
  return type === 'ado' ? adoPlan(cfg, items) : jiraPlan(cfg, items);
}

export async function push(type, cfg, secret, projectId, scope, { force = false } = {}) {
  const plan = buildPlan(type, cfg, projectId, scope);
  if (force) db.prepare('DELETE FROM sync_items WHERE project_id = ? AND type = ?').run(projectId, type);
  const synced = Object.fromEntries(db.prepare('SELECT local_id, external_id, external_url FROM sync_items WHERE project_id = ? AND type = ?').all(projectId, type).map((r) => [r.local_id, { id: r.external_id, url: r.external_url }]));
  const record = (localId, externalId, url) => db.prepare('INSERT OR REPLACE INTO sync_items (project_id, type, local_id, external_id, external_url) VALUES (?, ?, ?, ?, ?)').run(projectId, type, localId, externalId, url);
  const results = type === 'ado' ? await adoPush(cfg, secret, plan, synced, record) : await jiraPush(cfg, secret, plan, synced, record);
  const count = (s) => results.filter((r) => r.status === s).length;
  return { summary: { planned: plan.length, created: count('created'), skipped: count('skipped'), failed: count('failed') + count('aborted') + count('link-failed') }, results };
}

export async function testConnection(type, cfg, secret) {
  const url = type === 'ado'
    ? `https://dev.azure.com/${encodeURIComponent(cfg.organization)}/_apis/projects/${encodeURIComponent(cfg.project)}?api-version=7.1`
    : `${cfg.baseUrl.replace(/\/+$/, '')}/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}`;
  const auth = type === 'ado' ? `Basic ${Buffer.from(`:${secret}`).toString('base64')}` : `Basic ${Buffer.from(`${cfg.email}:${secret}`).toString('base64')}`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { ok: false, message: `HTTP ${res.status} - check credentials and project` };
  const body = await res.json().catch(() => ({}));
  return { ok: true, message: `Connected to ${body.name || cfg.project || cfg.projectKey}` };
}
