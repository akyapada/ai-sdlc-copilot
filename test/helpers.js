// Shared helpers for API-level tests: boots the app on a random port with an in-memory DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PASSWORD = 'TestPass1234';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const samples = path.join(import.meta.dirname, '..', 'samples');

export async function startApp() {
  process.env.NODE_ENV = 'test';
  process.env.AI_MODE = 'mock';
  process.env.DEMO_PASSWORD = PASSWORD;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-test-'));
  const { createApp } = await import('../src/server.js');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/api`, dataDir: process.env.DATA_DIR };
}

export function client(base) {
  let cookie = '';
  const call = async (method, p, { body, form } = {}) => {
    const headers = { 'X-Requested-With': 'sdlc-app' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { call, login: (email) => call('POST', '/auth/login', { body: { email, password: PASSWORD } }) };
}

export function fileForm(file, name, type) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)], { type }), name);
  return fd;
}

/** Logged-in clients for every demo role plus a project with the sample files uploaded. */
export async function setupProject(base, name = 'Integrity') {
  const users = {};
  for (const u of ['admin', 'pm', 'architect', 'dev', 'qa']) { users[u] = client(base); await users[u].login(`${u}@demo.local`); }
  const dir = (await users.pm.call('GET', '/admin/directory')).body;
  const pid = (await users.pm.call('POST', '/projects', { body: { name, memberIds: dir.map((u) => u.id) } })).body.id;
  await users.pm.call('POST', `/projects/${pid}/files/requirements`, { form: fileForm(path.join(samples, 'requirements-sample.docx'), 'r.docx', DOCX) });
  await users.pm.call('POST', `/projects/${pid}/files/team`, { form: fileForm(path.join(samples, 'team-sample.xlsx'), 't.xlsx', XLSX) });
  return { users, pid, st: (s) => `/projects/${pid}/stages/${s}` };
}
