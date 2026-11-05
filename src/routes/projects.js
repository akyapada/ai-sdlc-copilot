import { Router } from 'express';
import multer from 'multer';
import { db, json } from '../db.js';
import { config } from '../config.js';
import { audit, projectAccess, requireRole, can, stagePermissions, encryptSecret, decryptSecret } from '../security.js';
import { processUpload, FileValidationError, deleteStoredFile } from '../files.js';
import {
  STAGES, STAGE_LABEL, GateError, workflowStatus, runStage, regenerateWithFeedback, saveHumanEdit, decide,
  latestArtifact, artifactVersion, isStale, latestFile, traceability,
} from '../agents/orchestrator.js';
import { collectBundle, toExcel, toJiraCsv, toAdoCsv, toMarkdown } from '../exporters/bundle.js';
import { validateConfig, buildPlan, push, testConnection } from '../exporters/integrations.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const validStage = (req, res, next) => (STAGES.includes(req.params.stage) ? next() : res.status(400).json({ error: 'Unknown stage' }));
const needStage = (action) => (req, res, next) => (can(req.user, req.params.stage, action) ? next() : res.status(403).json({ error: `Your role (${req.user.role}) cannot ${action} ${STAGE_LABEL[req.params.stage].toLowerCase()}` }));
const needPerm = (perm) => (req, res, next) => (stagePermissions(req.user)[perm] ? next() : res.status(403).json({ error: `Your role (${req.user.role}) is not permitted to ${perm}` }));

// ---------------- Projects ----------------
router.get('/', (req, res) => {
  const rows = req.user.role === 'ADMIN'
    ? db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
    : db.prepare('SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC').all(req.user.id);
  res.json(rows.map((p) => ({ ...p, workflow: workflowStatus(p.id) })));
});

router.post('/', requireRole('PM', 'ADMIN'), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 120) return res.status(400).json({ error: 'Project name required (max 120 chars)' });
  const info = db.prepare('INSERT INTO projects (name, description, created_by) VALUES (?, ?, ?)').run(name, String(req.body?.description || '').slice(0, 1000), req.user.id);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  for (const uid of (req.body?.memberIds || []).map(Number).filter(Number.isInteger)) {
    db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) SELECT ?, id FROM users WHERE id = ?').run(id, uid);
  }
  audit(req, 'PROJECT_CREATED', { projectId: id, entity: 'project', entityId: id, details: { name } });
  res.status(201).json({ id });
});

router.get('/:projectId', projectAccess, (req, res) => {
  const members = db.prepare('SELECT u.id, u.name, u.email, u.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.role, u.name').all(req.project.id);
  res.json({ project: req.project, members, workflow: workflowStatus(req.project.id), permissions: stagePermissions(req.user) });
});

router.delete('/:projectId', projectAccess, requireRole('ADMIN'), (req, res) => {
  const files = db.prepare('SELECT stored_name FROM files WHERE project_id = ?').all(req.project.id);
  for (const f of files) deleteStoredFile(f.stored_name);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.project.id);
  audit(req, 'PROJECT_DELETED', { projectId: req.project.id, entity: 'project', entityId: req.project.id, details: { name: req.project.name, filesDeleted: files.length } });
  res.json({ ok: true });
});

router.post('/:projectId/members', projectAccess, needPerm('manageMembers'), (req, res) => {
  const userId = Number(req.body?.userId);
  const u = db.prepare('SELECT id, email FROM users WHERE id = ? AND active = 1').get(userId);
  if (!u) return res.status(404).json({ error: 'User not found or inactive' });
  db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').run(req.project.id, userId);
  audit(req, 'MEMBER_ADDED', { projectId: req.project.id, entity: 'user', entityId: userId, details: { email: u.email } });
  res.json({ ok: true });
});

router.delete('/:projectId/members/:userId', projectAccess, needPerm('manageMembers'), (req, res) => {
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(req.project.id, Number(req.params.userId));
  audit(req, 'MEMBER_REMOVED', { projectId: req.project.id, entity: 'user', entityId: req.params.userId });
  res.json({ ok: true });
});

// ---------------- Files ----------------
router.get('/:projectId/files', projectAccess, (req, res) => {
  const rows = db.prepare(`SELECT f.id, f.kind, f.version, f.original_name, f.sha256, f.size, f.validation_json, f.uploaded_at, u.name AS uploaded_by
                           FROM files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.project_id = ? ORDER BY f.kind, f.version DESC`).all(req.project.id);
  const team = latestFile(req.project.id, 'team')?.parsed?.members || [];
  const reqDoc = latestFile(req.project.id, 'requirements')?.parsed;
  res.json({
    files: rows.map((r) => ({ ...r, validation: json.parse(r.validation_json), validation_json: undefined })),
    team,
    requirementsPreview: reqDoc ? { title: reqDoc.title, wordCount: reqDoc.wordCount, requirementIds: reqDoc.requirementIds, paragraphs: reqDoc.paragraphs.slice(0, 60) } : null,
  });
});

router.post('/:projectId/files/:kind', projectAccess, needPerm('upload'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${config.maxUploadBytes / 1048576} MB limit` : err.message;
      audit(req, 'UPLOAD_REJECTED', { projectId: req.project.id, details: { kind: req.params.kind, reason: msg } });
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, wrap(async (req, res) => {
  const { kind } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field "file")' });
  try {
    const r = await processUpload(kind, req.file);
    const version = (db.prepare('SELECT MAX(version) AS v FROM files WHERE project_id = ? AND kind = ?').get(req.project.id, kind).v || 0) + 1;
    const originalName = req.file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 150);
    const info = db.prepare(`INSERT INTO files (project_id, kind, version, original_name, stored_name, sha256, size, parsed_json, validation_json, uploaded_by)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.project.id, kind, version, originalName, r.storedName, r.sha256, r.size, json.str(r.parsed), json.str(r.validation), req.user.id);
    audit(req, 'FILE_UPLOADED', { projectId: req.project.id, entity: 'file', entityId: info.lastInsertRowid, details: { kind, version, name: originalName, sha256: r.sha256, warnings: r.validation.warnings.length } });
    res.status(201).json({ id: Number(info.lastInsertRowid), version, validation: r.validation, summary: kind === 'team' ? { members: r.parsed.members.length } : { words: r.parsed.wordCount, requirementIds: r.parsed.requirementIds } });
  } catch (e) {
    if (e instanceof FileValidationError) {
      audit(req, 'UPLOAD_REJECTED', { projectId: req.project.id, details: { kind, name: req.file.originalname, errors: e.errors } });
      return res.status(422).json({ error: 'File validation failed', errors: e.errors });
    }
    throw e;
  }
}));

// ---------------- Workflow / artefacts ----------------
router.get('/:projectId/workflow', projectAccess, (req, res) => res.json(workflowStatus(req.project.id)));

function artifactResponse(projectId, art) {
  if (!art) return null;
  const reviews = db.prepare('SELECT reviewer_name, decision, comments, created_at FROM reviews WHERE artifact_id = ? ORDER BY id').all(art.id);
  const versions = db.prepare('SELECT version, status, source, engine, created_at FROM artifacts WHERE project_id = ? AND stage = ? ORDER BY version DESC').all(projectId, art.stage);
  const creator = db.prepare('SELECT name FROM users WHERE id = ?').get(art.createdBy);
  return { ...art, createdByName: creator?.name, stale: isStale(projectId, art), reviews, versions };
}

router.get('/:projectId/stages/:stage', projectAccess, validStage, (req, res) => {
  const v = req.query.version ? Number(req.query.version) : null;
  const art = v ? artifactVersion(req.project.id, req.params.stage, v) : latestArtifact(req.project.id, req.params.stage);
  const team = latestFile(req.project.id, 'team')?.parsed?.members || [];
  res.json({ artifact: artifactResponse(req.project.id, art), workflow: workflowStatus(req.project.id), team, permissions: stagePermissions(req.user)[req.params.stage] });
});

router.post('/:projectId/stages/:stage/generate', projectAccess, validStage, needStage('generate'), wrap(async (req, res) => {
  const t0 = Date.now();
  const art = await runStage(req.project.id, req.params.stage, req.user.id);
  audit(req, 'AI_GENERATED', { projectId: req.project.id, entity: req.params.stage, entityId: art.version, details: { engine: art.engine, criticScore: art.critic.score, guardrailPassed: art.guardrail.passed, ms: Date.now() - t0 } });
  res.status(201).json({ artifact: artifactResponse(req.project.id, art) });
}));

router.post('/:projectId/stages/:stage/regenerate', projectAccess, validStage, needStage('edit'), wrap(async (req, res) => {
  const feedback = String(req.body?.feedback || '').slice(0, 8000);
  if (!feedback.trim() && !req.body?.addressCritic) return res.status(400).json({ error: 'Provide feedback or choose to address critic findings' });
  const art = await regenerateWithFeedback(req.project.id, req.params.stage, { baseVersion: Number(req.body?.baseVersion) || null, feedback, addressCritic: Boolean(req.body?.addressCritic), userId: req.user.id });
  const base = db.prepare("SELECT id FROM artifacts WHERE project_id = ? AND stage = ? AND version = ?").get(req.project.id, req.params.stage, Number(req.body?.baseVersion) || art.version - 1);
  if (base) db.prepare("INSERT INTO reviews (artifact_id, reviewer_id, reviewer_name, decision, comments) VALUES (?, ?, ?, 'REGENERATE', ?)").run(base.id, req.user.id, req.user.name, feedback || 'Address critic findings');
  audit(req, 'AI_REGENERATED_WITH_FEEDBACK', { projectId: req.project.id, entity: req.params.stage, entityId: art.version, details: { feedbackChars: feedback.length, addressCritic: Boolean(req.body?.addressCritic), changes: art.changes.changeLog.length, criticScore: art.critic.score } });
  res.status(201).json({ artifact: artifactResponse(req.project.id, art) });
}));

router.put('/:projectId/stages/:stage', projectAccess, validStage, needStage('edit'), wrap(async (req, res) => {
  const content = req.body?.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return res.status(400).json({ error: 'content object required' });
  if (JSON.stringify(content).length > 2_000_000) return res.status(413).json({ error: 'Content too large' });
  const art = await saveHumanEdit(req.project.id, req.params.stage, { content, userId: req.user.id, comment: String(req.body?.comment || '').slice(0, 2000) });
  audit(req, 'HUMAN_EDIT', { projectId: req.project.id, entity: req.params.stage, entityId: art.version, details: { diff: { added: art.changes.diff.added.length, removed: art.changes.diff.removed.length, modified: art.changes.diff.modified.length } } });
  res.json({ artifact: artifactResponse(req.project.id, art) });
}));

router.post('/:projectId/stages/:stage/versions/:version/decision', projectAccess, validStage, (req, res) => {
  const decision = String(req.body?.decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED', 'COMMENT'].includes(decision)) return res.status(400).json({ error: 'decision must be APPROVED, REJECTED or COMMENT' });
  const { stage } = req.params;
  const version = Number(req.params.version);
  const comments = String(req.body?.comments || '').trim().slice(0, 4000);
  if (decision === 'COMMENT') {
    const art = artifactVersion(req.project.id, stage, version);
    if (!art) return res.status(404).json({ error: 'Version not found' });
    if (!comments) return res.status(400).json({ error: 'Comment text required' });
    db.prepare("INSERT INTO reviews (artifact_id, reviewer_id, reviewer_name, decision, comments) VALUES (?, ?, ?, 'COMMENT', ?)").run(art.id, req.user.id, req.user.name, comments);
    audit(req, 'REVIEW_COMMENT', { projectId: req.project.id, entity: stage, entityId: version });
    return res.json({ artifact: artifactResponse(req.project.id, art) });
  }
  if (!can(req.user, stage, 'approve')) {
    audit(req, 'APPROVAL_DENIED', { projectId: req.project.id, entity: stage, entityId: version });
    return res.status(403).json({ error: `Only ${stage === 'architecture' ? 'the Software Architect' : 'authorised reviewers'} can ${decision.toLowerCase().replace('ed', '')} ${STAGE_LABEL[stage].toLowerCase()}` });
  }
  const art = decide(req.project.id, stage, version, { decision, comments, acknowledgeRisks: Boolean(req.body?.acknowledgeRisks), user: req.user });
  audit(req, decision === 'APPROVED' ? 'GATE_APPROVED' : 'GATE_REJECTED', { projectId: req.project.id, entity: stage, entityId: version, details: { reviewer: req.user.name, comments, acknowledgedRisks: Boolean(req.body?.acknowledgeRisks) } });
  res.json({ artifact: artifactResponse(req.project.id, art) });
});

router.get('/:projectId/traceability', projectAccess, (req, res) => res.json(traceability(req.project.id)));

router.get('/:projectId/audit', projectAccess, requireRole('ADMIN', 'PM', 'ARCHITECT', 'QA'), (req, res) => {
  res.json(db.prepare('SELECT id, ts, user_email, action, entity, entity_id, details_json FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 1000').all(req.project.id));
});

// ---------------- Exports ----------------
router.get('/:projectId/export/:format', projectAccess, needPerm('export'), wrap(async (req, res) => {
  const bundle = collectBundle(req.project.id, { approvedOnly: req.query.approvedOnly === 'true' });
  const base = req.project.name.replace(/[^\w-]+/g, '_').slice(0, 60) || 'project';
  const { format } = req.params;
  audit(req, 'EXPORTED', { projectId: req.project.id, details: { format, approvedOnly: req.query.approvedOnly === 'true' } });
  const send = (body, type, ext) => {
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${base}.${ext}"`);
    res.send(body);
  };
  if (format === 'xlsx') return send(Buffer.from(await toExcel(bundle)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');
  if (format === 'json') return send(JSON.stringify(bundle, null, 2), 'application/json', 'json');
  if (format === 'md') return send(toMarkdown(bundle), 'text/markdown; charset=utf-8', 'md');
  if (format === 'jira-csv') return send(`﻿${toJiraCsv(bundle)}`, 'text/csv; charset=utf-8', 'jira.csv');
  if (format === 'ado-csv') return send(`﻿${toAdoCsv(bundle)}`, 'text/csv; charset=utf-8', 'ado.csv');
  res.status(400).json({ error: 'Unknown format' });
}));

// ---------------- Integrations (ADO / Jira) ----------------
const validType = (req, res, next) => (['ado', 'jira'].includes(req.params.type) ? next() : res.status(400).json({ error: 'type must be ado or jira' }));

function loadIntegration(projectId, type) {
  const row = db.prepare('SELECT * FROM integrations WHERE project_id = ? AND type = ?').get(projectId, type);
  return row ? { config: json.parse(row.config_json, {}), secret: decryptSecret(row.secret_enc), hasSecret: Boolean(row.secret_enc), updatedAt: row.updated_at } : null;
}

router.get('/:projectId/integrations', projectAccess, needPerm('integrate'), (req, res) => {
  const out = {};
  for (const t of ['ado', 'jira']) {
    const i = loadIntegration(req.project.id, t);
    out[t] = i ? { config: i.config, hasSecret: i.hasSecret, updatedAt: i.updatedAt, synced: db.prepare('SELECT COUNT(*) AS c FROM sync_items WHERE project_id = ? AND type = ?').get(req.project.id, t).c } : null;
  }
  res.json(out);
});

router.put('/:projectId/integrations/:type', projectAccess, needPerm('integrate'), validType, (req, res) => {
  const { type } = req.params;
  const cfg = req.body?.config || {};
  const clean = type === 'ado'
    ? { organization: String(cfg.organization || '').trim(), project: String(cfg.project || '').trim(), areaPath: String(cfg.areaPath || '').trim(), iterationPath: String(cfg.iterationPath || '').trim(), workItemTypes: cfg.workItemTypes || {}, assigneeMap: cfg.assigneeMap || {} }
    : { baseUrl: String(cfg.baseUrl || '').trim(), email: String(cfg.email || '').trim(), projectKey: String(cfg.projectKey || '').trim().toUpperCase(), issueTypes: cfg.issueTypes || {}, assigneeMap: cfg.assigneeMap || {}, useParent: cfg.useParent !== false };
  const errors = validateConfig(type, clean);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const existing = loadIntegration(req.project.id, type);
  const secret = req.body?.secret ? String(req.body.secret) : existing?.secret || null;
  db.prepare(`INSERT INTO integrations (project_id, type, config_json, secret_enc, updated_by) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(project_id, type) DO UPDATE SET config_json = excluded.config_json, secret_enc = excluded.secret_enc, updated_by = excluded.updated_by, updated_at = datetime('now')`)
    .run(req.project.id, type, json.str(clean), encryptSecret(secret), req.user.id);
  audit(req, 'INTEGRATION_CONFIGURED', { projectId: req.project.id, entity: 'integration', entityId: type, details: { ...clean, assigneeMap: Object.keys(clean.assigneeMap).length, secretUpdated: Boolean(req.body?.secret) } });
  res.json({ ok: true });
});

router.post('/:projectId/integrations/:type/test', projectAccess, needPerm('integrate'), validType, wrap(async (req, res) => {
  const i = loadIntegration(req.project.id, req.params.type);
  if (!i?.secret) return res.status(400).json({ error: 'Save configuration with a token first' });
  try {
    const r = await testConnection(req.params.type, i.config, i.secret);
    audit(req, 'INTEGRATION_TESTED', { projectId: req.project.id, entity: 'integration', entityId: req.params.type, details: { ok: r.ok } });
    res.json(r);
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
}));

router.post('/:projectId/integrations/:type/push', projectAccess, needPerm('integrate'), validType, wrap(async (req, res) => {
  const { type } = req.params;
  const scope = (req.body?.scope || ['requirements', 'tasks', 'tests']).filter((s) => ['requirements', 'tasks', 'tests'].includes(s));
  const dryRun = req.body?.dryRun !== false;
  const i = loadIntegration(req.project.id, type);
  if (!i) return res.status(400).json({ error: `Configure ${type.toUpperCase()} first` });
  try {
    if (dryRun) {
      const plan = buildPlan(type, i.config, req.project.id, scope);
      audit(req, 'INTEGRATION_DRY_RUN', { projectId: req.project.id, entity: 'integration', entityId: type, details: { items: plan.length, scope } });
      return res.json({ dryRun: true, count: plan.length, plan: plan.slice(0, 300) });
    }
    if (!i.secret) return res.status(400).json({ error: 'No access token saved' });
    const result = await push(type, i.config, i.secret, req.project.id, scope, { force: Boolean(req.body?.force) });
    audit(req, 'INTEGRATION_PUSHED', { projectId: req.project.id, entity: 'integration', entityId: type, details: { ...result.summary, scope } });
    res.json({ dryRun: false, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

// Map orchestrator gate errors to HTTP responses.
router.use((err, req, res, next) => {
  if (err instanceof GateError) {
    audit(req, 'GATE_BLOCKED', { projectId: req.project?.id, entity: req.params?.stage, details: { reason: err.message } });
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
});

export default router;
