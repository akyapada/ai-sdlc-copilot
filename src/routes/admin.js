import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, ROLES } from '../db.js';
import { audit, requireRole, validatePassword } from '../security.js';

const router = Router();

// Directory used by PMs to add project members (no sensitive fields).
router.get('/directory', (req, res) => {
  res.json(db.prepare('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY name').all());
});

router.use(requireRole('ADMIN'));

router.get('/users', (req, res) => {
  res.json(db.prepare('SELECT id, email, name, role, active, locked_until, created_at FROM users ORDER BY created_at DESC').all());
});

router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { role, active, unlock } = req.body || {};
  if (id === req.user.id && (active === false || (role && role !== 'ADMIN'))) return res.status(400).json({ error: 'You cannot deactivate or demote yourself' });
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  db.prepare('UPDATE users SET role = COALESCE(?, role), active = COALESCE(?, active), locked_until = CASE WHEN ? THEN NULL ELSE locked_until END, failed_logins = CASE WHEN ? THEN 0 ELSE failed_logins END WHERE id = ?')
    .run(role || null, active == null ? null : active ? 1 : 0, unlock ? 1 : 0, unlock ? 1 : 0, id);
  audit(req, active === false ? 'USER_DEACTIVATED' : active === true ? 'USER_ACTIVATED' : 'USER_UPDATED', { entity: 'user', entityId: id, details: { role, active, unlock, email: user.email } });
  res.json({ ok: true });
});

router.post('/users', (req, res) => {
  const { email, name, role, password } = req.body || {};
  if (!email || !name || !ROLES.includes(role)) return res.status(400).json({ error: 'email, name and valid role required' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email already exists' });
  const info = db.prepare('INSERT INTO users (email, name, password_hash, role, active) VALUES (?, ?, ?, ?, 1)').run(email, name, bcrypt.hashSync(password, 10), role);
  audit(req, 'USER_CREATED', { entity: 'user', entityId: info.lastInsertRowid, details: { email, role } });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.post('/users/:id/reset-password', (req, res) => {
  const id = Number(req.params.id);
  const pwErr = validatePassword(req.body?.password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const r = db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(bcrypt.hashSync(req.body.password, 10), id);
  if (!r.changes) return res.status(404).json({ error: 'User not found' });
  audit(req, 'PASSWORD_RESET', { entity: 'user', entityId: id });
  res.json({ ok: true });
});

router.get('/audit', (req, res) => {
  const { projectId, action, limit = 500 } = req.query;
  const where = [];
  const params = [];
  if (projectId) { where.push('project_id = ?'); params.push(Number(projectId)); }
  if (action) { where.push('action LIKE ?'); params.push(`%${String(action).slice(0, 40)}%`); }
  const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 500, 5000));
  res.json(rows);
});

export default router;
