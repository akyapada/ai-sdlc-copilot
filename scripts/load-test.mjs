// Load test: runs the full AI workflow for many projects concurrently against an in-process server
// (offline engine, in-memory DB) and checks latency budgets. Usage: npm run load -- [projects] [requests] [concurrent users]
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { startApp, client, fileForm, samples, DOCX, XLSX } from '../test/helpers.js';

const PROJECTS = Number(process.argv[2] || 20);
const READERS = Number(process.argv[3] || 200);
const CONCURRENCY = Number(process.argv[4] || 50);
const BUDGET = { 'GET workflow': 200, 'upload requirements': 1000, 'upload team': 1000, 'generate requirements': 2000, 'approve': 500, 'generate architecture': 2000, 'generate tasks': 2000, 'generate tests': 2000, 'export xlsx': 2000 };

const { server, base } = await startApp();
const timings = {};
const errors = {};
async function timed(name, fn) {
  const t0 = performance.now();
  const r = await fn();
  (timings[name] ||= []).push(performance.now() - t0);
  if (r.status >= 400) (errors[name] ||= []).push(r.status);
  return r;
}

const pm = client(base);
const architect = client(base);
const qa = client(base);
await pm.login('pm@demo.local');
await architect.login('architect@demo.local');
await qa.login('qa@demo.local');
const dir = (await pm.call('GET', '/admin/directory')).body;
const pids = [];
for (let i = 0; i < PROJECTS; i++) pids.push((await pm.call('POST', '/projects', { body: { name: `Load ${i}`, memberIds: dir.map((u) => u.id) } })).body.id);

const t0 = performance.now();
await Promise.all(pids.map(async (pid) => {
  const st = (s) => `/projects/${pid}/stages/${s}`;
  await timed('upload requirements', () => pm.call('POST', `/projects/${pid}/files/requirements`, { form: fileForm(path.join(samples, 'requirements-sample.docx'), 'r.docx', DOCX) }));
  await timed('upload team', () => pm.call('POST', `/projects/${pid}/files/team`, { form: fileForm(path.join(samples, 'team-sample.xlsx'), 't.xlsx', XLSX) }));
  const flow = [['requirements', pm, pm], ['architecture', architect, architect], ['tasks', pm, pm], ['tests', qa, qa]];
  for (const [stage, gen, appr] of flow) {
    const a = (await timed(`generate ${stage}`, () => gen.call('POST', `${st(stage)}/generate`))).body.artifact;
    if (a) await timed('approve', () => appr.call('POST', `${st(stage)}/versions/${a.version}/decision`, { body: { decision: 'APPROVED', comments: 'load' } }));
  }
  await timed('export xlsx', () => pm.call('GET', `/projects/${pid}/export/xlsx`));
}));
const workflowSecs = (performance.now() - t0) / 1000;

const t1 = performance.now();
// READERS requests from CONCURRENCY simultaneous users (each user waits for its response before the next).
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < READERS) { const i = next++; await timed('GET workflow', () => pm.call('GET', `/projects/${pids[i % pids.length]}/workflow`)); }
}));
const readSecs = (performance.now() - t1) / 1000;
server.close();

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const rows = Object.entries(timings).map(([name, a]) => {
  a.sort((x, y) => x - y);
  const p95 = pct(a, 95);
  return { step: name, n: a.length, 'p50 ms': Math.round(pct(a, 50)), 'p95 ms': Math.round(p95), 'max ms': Math.round(a[a.length - 1]), 'budget p95': BUDGET[name] ?? '-', errors: (errors[name] || []).length, result: (errors[name]?.length || p95 > (BUDGET[name] ?? Infinity)) ? 'FAIL' : 'pass' };
});
console.log(`\n${PROJECTS} projects run end to end concurrently in ${workflowSecs.toFixed(1)}s; ${READERS} reads from ${CONCURRENCY} concurrent users in ${readSecs.toFixed(2)}s (${Math.round(READERS / readSecs)} req/s)\n`);
console.table(rows);
const failed = rows.filter((r) => r.result === 'FAIL');
if (failed.length) { console.error(`\nFAILED budgets: ${failed.map((r) => r.step).join(', ')}`); process.exit(1); }
console.log('\nAll latency budgets met.');
