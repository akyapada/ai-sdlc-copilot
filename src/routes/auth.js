import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db, ROLES } from '../db.js';
import { audit, authenticate, issueSession, clearSession, validatePassword, stagePermissions } from '../security.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: true, legacyHeaders: false });

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10); // equalise timing for unknown emails

router.post('/register', limiter, (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email || '')) return res.status(400).json({ error: 'Valid email required' });
  if (!name || String(name).length > 80) return res.status(400).json({ error: 'Name required (max 80 chars)' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const requested = ROLES.includes(role) && role !== 'ADMIN' ? role : 'DEVELOPER';
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email already registered' });
  // Self-registered accounts start inactive: an administrator must approve the account and role.
  const info = db.prepare('INSERT INTO users (email, name, password_hash, role, active) VALUES (?, ?, ?, ?, 0)').run(email, String(name).trim(), bcrypt.hashSync(password, 10), requested);
  audit(req, 'USER_REGISTERED', { entity: 'user', entityId: info.lastInsertRowid, details: { email, requestedRole: requested } });
  res.status(201).json({ message: 'Registration received. An administrator must activate your account.' });
});

router.post('/login', limiter, (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || ''));
  const fail = (msg = 'Invalid email or password') => {
    audit(req, 'LOGIN_FAILED', { details: { email: String(email || '').slice(0, 120) } });
    return res.status(401).json({ error: msg });
  };
  if (!user) { bcrypt.compareSync(String(password || ''), DUMMY_HASH); return fail(); }
  if (user.locked_until && new Date(user.locked_until) > new Date()) return fail(`Account locked. Try again after ${new Date(user.locked_until).toLocaleTimeString()}`);
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    const n = user.failed_logins + 1;
    const lock = n >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
    db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : n, lock, user.id);
    if (lock) audit(req, 'ACCOUNT_LOCKED', { entity: 'user', entityId: user.id, details: { email: user.email } });
    return fail();
  }
  if (!user.active) return fail('Account is not active. Contact an administrator.');
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
  issueSession(res, user);
  req.user = user;
  audit(req, 'LOGIN', { entity: 'user', entityId: user.id });
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

router.post('/logout', authenticate, (req, res) => {
  audit(req, 'LOGOUT', { entity: 'user', entityId: req.user.id });
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user, permissions: stagePermissions(req.user) });
});

router.post('/change-password', authenticate, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(currentPassword || ''), row.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  audit(req, 'PASSWORD_CHANGED', { entity: 'user', entityId: req.user.id });
  res.json({ ok: true });
});

export default router;
