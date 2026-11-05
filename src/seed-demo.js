// Demo seed: on start-up, (re)creates the handbook sample project and runs the positive flow through all
// four gates as the real PM, Architect and QA users. Hosting without persistent storage (Render free plan)
// therefore always shows a completed sample project. Enabled with SEED_DEMO_PROJECT=true.
import fs from 'node:fs';
import path from 'node:path';
import { db, json } from './db.js';
import { config } from './config.js';
import { audit } from './security.js';
import { processUpload } from './files.js';
import { runStage, decide } from './agents/orchestrator.js';

export const DEMO_PROJECT_NAME = 'GlobalCommerce Express Checkout (sample)';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Positive flow: who generates and who approves each gate (mirrors STAGE_PERMISSIONS).
const FLOW = [
  ['requirements', 'pm@demo.local', 'pm@demo.local', 'Requirements reviewed with the product owner; ambiguities tracked as open questions.'],
  ['architecture', 'architect@demo.local', 'architect@demo.local', 'Architecture approved for planning.'],
  ['tasks', 'pm@demo.local', 'pm@demo.local', 'Assignments and sequencing reviewed.'],
  ['tests', 'qa@demo.local', 'qa@demo.local', 'Test coverage approved; every requirement traced.'],
];

export const seedStatus = { state: 'off', projectId: null, error: null };

export async function seedDemoProject() {
  if (process.env.SEED_DEMO_PROJECT !== 'true') return seedStatus;
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(DEMO_PROJECT_NAME);
  if (existing) return Object.assign(seedStatus, { state: 'ready', projectId: existing.id });
  seedStatus.state = 'seeding';
  try {
    const user = (email) => {
      const u = db.prepare('SELECT id, email, name, role FROM users WHERE email = ? AND active = 1').get(email);
      if (!u) throw new Error(`Demo user ${email} not found (SEED_DEMO_USERS must be true)`);
      return u;
    };
    const as = (u) => ({ user: u, ip: 'seed' });
    const pm = user('pm@demo.local');

    const info = db.prepare('INSERT INTO projects (name, description, created_by) VALUES (?, ?, ?)')
      .run(DEMO_PROJECT_NAME, 'Sample use case from the Code-a-thon handbook, run through all four approval gates.', pm.id);
    const projectId = Number(info.lastInsertRowid);
    for (const u of db.prepare('SELECT id FROM users WHERE active = 1').all()) {
      db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').run(projectId, u.id);
    }
    audit(as(pm), 'PROJECT_CREATED', { projectId, entity: 'project', entityId: projectId, details: { name: DEMO_PROJECT_NAME, seeded: true } });

    const samples = path.join(config.root, 'samples');
    for (const [kind, file, mime, shown] of [
      ['requirements', 'requirements-sample.docx', DOCX, 'Code-a-thon Sample Input sheet.docx'],
      ['team', 'team-sample.xlsx', XLSX, 'Code-a-thon Sample Input_Team-Template.xlsx'],
    ]) {
      const r = await processUpload(kind, { originalname: shown, mimetype: mime, buffer: fs.readFileSync(path.join(samples, file)) });
      const f = db.prepare(`INSERT INTO files (project_id, kind, version, original_name, stored_name, sha256, size, parsed_json, validation_json, uploaded_by)
                            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(projectId, kind, shown, r.storedName, r.sha256, r.size, json.str(r.parsed), json.str(r.validation), pm.id);
      audit(as(pm), 'FILE_UPLOADED', { projectId, entity: 'file', entityId: f.lastInsertRowid, details: { kind, version: 1, name: shown, sha256: r.sha256, seeded: true } });
    }

    for (const [stage, genEmail, apprEmail, comment] of FLOW) {
      const gen = user(genEmail);
      const art = await runStage(projectId, stage, gen.id);
      audit(as(gen), 'AI_GENERATED', { projectId, entity: stage, entityId: art.version, details: { engine: art.engine, criticScore: art.critic.score, seeded: true } });
      const appr = user(apprEmail);
      decide(projectId, stage, art.version, { decision: 'APPROVED', comments: comment, acknowledgeRisks: false, user: appr });
      audit(as(appr), 'GATE_APPROVED', { projectId, entity: stage, entityId: art.version, details: { reviewer: appr.name, comments: comment, seeded: true } });
    }
    Object.assign(seedStatus, { state: 'ready', projectId, error: null });
    console.log(`[seed] Sample project "${DEMO_PROJECT_NAME}" created (id ${projectId}) with all four gates approved.`);
  } catch (e) {
    Object.assign(seedStatus, { state: 'error', error: e.message });
    console.error('[seed] Could not create the sample project:', e);
  }
  return seedStatus;
}
