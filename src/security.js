import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { config } from './config.js';

// ---------- Audit ----------
export function audit(req, action, { projectId = null, entity = null, entityId = null, details = null } = {}) {
  const user = req?.user;
  db.prepare(`INSERT INTO audit_log (user_id, user_email, action, project_id, entity, entity_id, details_json, ip)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    user?.id ?? null,
    user?.email ?? details?.email ?? null,
    action,
    projectId,
    entity,
    entityId == null ? null : String(entityId),
    details ? JSON.stringify(details) : null,
    req?.ip ?? null,
  );
}

// ---------- Auth ----------
const COOKIE = 'sdlc_session';
const SESSION_HOURS = 8;

export function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, config.appSecret, { expiresIn: `${SESSION_HOURS}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.env === 'production',
    maxAge: SESSION_HOURS * 3600 * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE);
}

export function authenticate(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, config.appSecret);
    const user = db.prepare('SELECT id, email, name, role, active FROM users WHERE id = ?').get(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Account inactive or missing' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    next();
  };
}

// Simple CSRF defence on top of SameSite=Strict: state-changing requests must carry a custom header
// that cross-site HTML forms cannot set.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'sdlc-app') return res.status(403).json({ error: 'Missing CSRF header' });
  next();
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and digits';
  return null;
}

// ---------- Project access ----------
export function isMember(user, projectId) {
  if (user.role === 'ADMIN') return true;
  return Boolean(db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, user.id));
}

export function projectAccess(req, res, next) {
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'Invalid project id' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!isMember(req.user, projectId)) {
    audit(req, 'ACCESS_DENIED', { projectId, entity: 'project', entityId: projectId });
    return res.status(403).json({ error: 'You are not a member of this project' });
  }
  req.project = project;
  next();
}

// Stage-level permission matrix (role x workflow stage x action).
export const STAGE_PERMISSIONS = {
  requirements: { generate: ['PM', 'ARCHITECT'], edit: ['PM', 'ARCHITECT'], approve: ['PM', 'ARCHITECT'] },
  architecture: { generate: ['ARCHITECT', 'PM'], edit: ['ARCHITECT'], approve: ['ARCHITECT'] },
  tasks: { generate: ['PM', 'ARCHITECT'], edit: ['PM'], approve: ['PM'] },
  tests: { generate: ['QA', 'PM'], edit: ['QA'], approve: ['QA'] },
};

export function can(user, stage, action) {
  if (user.role === 'ADMIN') return action !== 'approve'; // admins administer; reviewers approve
  return STAGE_PERMISSIONS[stage]?.[action]?.includes(user.role) ?? false;
}

export function stagePermissions(user) {
  const out = {};
  for (const stage of Object.keys(STAGE_PERMISSIONS)) {
    out[stage] = { generate: can(user, stage, 'generate'), edit: can(user, stage, 'edit'), approve: can(user, stage, 'approve') };
  }
  out.upload = ['PM', 'ARCHITECT', 'ADMIN'].includes(user.role);
  out.export = ['PM', 'ADMIN', 'ARCHITECT', 'QA'].includes(user.role);
  out.integrate = ['PM', 'ADMIN'].includes(user.role);
  out.manageMembers = ['PM', 'ADMIN'].includes(user.role);
  return out;
}

// ---------- Secret encryption at rest (AES-256-GCM) ----------
const key = crypto.scryptSync(config.appSecret, 'sdlc-integration-secrets', 32);

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
