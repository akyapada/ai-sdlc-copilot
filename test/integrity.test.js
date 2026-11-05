// Data-integrity tests: concurrency, versioning, isolation, rollback of rejected input, audit coverage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, setupProject, client, fileForm, samples, DOCX } from './helpers.js';

let app;
let ctx;
before(async () => { app = await startApp(); ctx = await setupProject(app.base); });
after(() => app.server.close());

const approve = (u, s, v, extra = {}) => ctx.users[u].call('POST', `${ctx.st(s)}/versions/${v}/decision`, { body: { decision: 'APPROVED', comments: 'ok', ...extra } });

test('concurrent generations get distinct versions and exactly one is in review', async () => {
  const { pm } = ctx.users;
  const rs = await Promise.all([1, 2, 3].map(() => pm.call('POST', `${ctx.st('requirements')}/generate`)));
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201]);
  assert.deepEqual(rs.map((r) => r.body.artifact.version).sort(), [1, 2, 3]);
  const versions = (await pm.call('GET', ctx.st('requirements'))).body.artifact.versions;
  assert.equal(versions.filter((v) => v.status === 'IN_REVIEW').length, 1);
  assert.equal(versions.filter((v) => v.status === 'SUPERSEDED').length, 2);
});

test('two reviewers approving the same version at once: one wins, one is refused', async () => {
  const rs = await Promise.all([approve('pm', 'requirements', 3), approve('architect', 'requirements', 3)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const art = (await ctx.users.pm.call('GET', `${ctx.st('requirements')}?version=3`)).body.artifact;
  assert.equal(art.reviews.filter((r) => r.decision === 'APPROVED').length, 1, 'single approval record');
});

test('a superseded version can never be approved', async () => {
  assert.equal((await approve('pm', 'requirements', 1)).status, 409);
});

test('only one approved version per stage; re-approval marks downstream stale', async () => {
  const { pm, architect } = ctx.users;
  await architect.call('POST', `${ctx.st('architecture')}/generate`);
  assert.equal((await approve('architect', 'architecture', 1)).status, 200);
  const v4 = (await pm.call('POST', `${ctx.st('requirements')}/generate`)).body.artifact.version;
  assert.equal((await approve('pm', 'requirements', v4)).status, 200);
  const versions = (await pm.call('GET', ctx.st('requirements'))).body.artifact.versions;
  assert.equal(versions.filter((v) => v.status === 'APPROVED').length, 1);
  const wf = (await pm.call('GET', `/projects/${ctx.pid}/workflow`)).body;
  assert.equal(wf.stages.architecture.stale, true, 'architecture built on an older requirements version');
});

test('editing never mutates an existing version', async () => {
  const { pm, architect } = ctx.users;
  await architect.call('POST', `${ctx.st('architecture')}/generate`);
  await approve('architect', 'architecture', 2);
  const g = (await pm.call('POST', `${ctx.st('tasks')}/generate`)).body.artifact;
  const original = JSON.stringify(g.content);
  const edited = structuredClone(g.content);
  edited.tasks[0].title = 'CHANGED';
  const e = await pm.call('PUT', ctx.st('tasks'), { body: { content: edited, comment: 'edit' } });
  assert.equal(e.body.artifact.version, g.version + 1);
  const v1 = (await pm.call('GET', `${ctx.st('tasks')}?version=${g.version}`)).body.artifact;
  assert.equal(JSON.stringify(v1.content), original, 'old version untouched');
});

test('malformed or tampered edits are rejected or normalised', async () => {
  const { pm } = ctx.users;
  assert.equal((await pm.call('PUT', ctx.st('tasks'), { body: { content: [1, 2] } })).status, 400);
  assert.equal((await pm.call('PUT', ctx.st('tasks'), { body: { content: 'x' } })).status, 400);
  const dup = { tasks: [{ id: 'T-001', title: 'a', reqRefs: ['FR-101'] }, { id: 'T-001', title: 'b', reqRefs: ['FR-101'] }] };
  const r = await pm.call('PUT', ctx.st('tasks'), { body: { content: dup } });
  const ids = r.body.artifact.content.tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate IDs de-duplicated');
  const big = { tasks: [{ id: 'T-1', title: 'x'.repeat(2_100_000) }] };
  assert.ok([413, 400].includes((await pm.call('PUT', ctx.st('tasks'), { body: big })).status));
});

test('a rejected upload leaves no file on disk and no DB row', async () => {
  const dir = path.join(app.dataDir, 'uploads');
  const before = fs.readdirSync(dir).length;
  const filesBefore = (await ctx.users.pm.call('GET', `/projects/${ctx.pid}/files`)).body.files.length;
  const r = await ctx.users.pm.call('POST', `/projects/${ctx.pid}/files/requirements`, { form: fileForm(path.join(samples, 'panel-pack', '7-requirements-with-macro.docx'), 'm.docx', DOCX) });
  assert.equal(r.status, 422);
  assert.equal(fs.readdirSync(dir).length, before);
  assert.equal((await ctx.users.pm.call('GET', `/projects/${ctx.pid}/files`)).body.files.length, filesBefore);
});

test('projects are isolated: non-members see nothing, IDs from another project do not resolve', async () => {
  const { pm, admin } = ctx.users;
  const other = (await pm.call('POST', '/projects', { body: { name: 'Other' } })).body.id;
  const outsider = client(app.base);
  await admin.call('POST', '/admin/users', { body: { email: 'out@x.com', name: 'Out', role: 'QA', password: 'Outsider12345' } });
  await outsider.call('POST', '/auth/login', { body: { email: 'out@x.com', password: 'Outsider12345' } });
  for (const p of [`/projects/${ctx.pid}`, `/projects/${ctx.pid}/files`, `${ctx.st('requirements')}`, `/projects/${ctx.pid}/export/json`]) {
    assert.equal((await outsider.call('GET', p)).status, 403, p);
  }
  assert.equal((await outsider.call('GET', '/projects')).body.length, 0);
  const r = await pm.call('POST', `/projects/${other}/stages/requirements/versions/3/decision`, { body: { decision: 'APPROVED' } });
  assert.equal(r.status, 404, 'version 3 exists only in the first project');
});

test('every state-changing action leaves an audit record', async () => {
  const { pm, admin } = ctx.users;
  const count = async () => (await admin.call('GET', `/admin/audit?projectId=${ctx.pid}&limit=5000`)).body.length;
  const steps = [
    () => pm.call('POST', `${ctx.st('requirements')}/versions/4/decision`, { body: { decision: 'COMMENT', comments: 'note' } }),
    () => pm.call('POST', `${ctx.st('tasks')}/regenerate`, { body: { feedback: 'priority of T-001 to P1' } }),
    () => pm.call('GET', `/projects/${ctx.pid}/export/xlsx`),
    () => pm.call('POST', `${ctx.st('tests')}/generate`),
  ];
  for (const s of steps) {
    const n = await count();
    await s();
    assert.ok((await count()) > n, s.toString());
  }
});

test('account locks after 5 failed logins; admin unlock restores access; deactivation ends the session', async () => {
  const { admin } = ctx.users;
  await admin.call('POST', '/admin/users', { body: { email: 'lock@x.com', name: 'Lock', role: 'QA', password: 'LockedOut12345' } });
  const u = client(app.base);
  for (let i = 0; i < 5; i++) assert.equal((await u.call('POST', '/auth/login', { body: { email: 'lock@x.com', password: 'wrong-password-9' } })).status, 401);
  const locked = await u.call('POST', '/auth/login', { body: { email: 'lock@x.com', password: 'LockedOut12345' } });
  assert.equal(locked.status, 401);
  assert.match(locked.body.error, /locked/i);
  const id = (await admin.call('GET', '/admin/users')).body.find((x) => x.email === 'lock@x.com').id;
  await admin.call('PATCH', `/admin/users/${id}`, { body: { unlock: true } });
  assert.equal((await u.call('POST', '/auth/login', { body: { email: 'lock@x.com', password: 'LockedOut12345' } })).status, 200);
  assert.equal((await u.call('GET', '/projects')).status, 200);
  await admin.call('PATCH', `/admin/users/${id}`, { body: { active: false } });
  assert.equal((await u.call('GET', '/projects')).status, 401, 'existing session rejected after deactivation');
});

test('demo seed creates the sample project with all four gates approved, once', async () => {
  process.env.SEED_DEMO_PROJECT = 'true';
  const { seedDemoProject, DEMO_PROJECT_NAME } = await import('../src/seed-demo.js');
  const first = await seedDemoProject();
  assert.equal(first.state, 'ready', first.error || '');
  const again = await seedDemoProject();
  assert.equal(again.projectId, first.projectId, 'idempotent: no duplicate project');
  const { qa } = ctx.users;
  const list = (await qa.call('GET', '/projects')).body.filter((p) => p.name === DEMO_PROJECT_NAME);
  assert.equal(list.length, 1, 'QA is a member and sees exactly one sample project');
  const wf = list[0].workflow;
  for (const s of ['requirements', 'architecture', 'tasks', 'tests']) assert.equal(wf.stages[s].latestStatus, 'APPROVED', s);
  const trace = (await qa.call('GET', `/projects/${first.projectId}/traceability`)).body;
  assert.equal(trace.summary.fullyCovered, trace.summary.requirements);
  const arch = (await qa.call('GET', `/projects/${first.projectId}/stages/architecture`)).body.artifact;
  assert.equal(arch.reviews[0].reviewer_name, 'Arun (Architect)', 'approved by the architect, not a system user');
  delete process.env.SEED_DEMO_PROJECT;
});
