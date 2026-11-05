import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { config } from './config.js';

const uploadDir = path.join(config.dataDir, 'uploads');
const MAX_UNCOMPRESSED = 60 * 1024 * 1024;

const KINDS = {
  requirements: {
    ext: '.docx',
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'],
    requiredEntry: 'word/document.xml',
  },
  team: {
    ext: '.xlsx',
    mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
    requiredEntry: 'xl/workbook.xml',
  },
};

export class FileValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.errors = errors;
  }
}

/** Container-level checks: extension, MIME, magic bytes, OOXML structure, macros, zip-bomb. */
async function inspectContainer(kind, file) {
  const spec = KINDS[kind];
  const errors = [];
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext !== spec.ext) errors.push(`File must be a ${spec.ext} file (got "${ext || 'none'}")`);
  if (!spec.mimes.includes(file.mimetype)) errors.push(`Unexpected content type "${file.mimetype}"`);
  if (!file.buffer || file.buffer.length < 4 || file.buffer.readUInt32LE(0) !== 0x04034b50) {
    errors.push('File content is not a valid Office Open XML package');
  }
  if (errors.length) throw new FileValidationError(errors);

  let zip;
  try {
    zip = await JSZip.loadAsync(file.buffer);
  } catch {
    throw new FileValidationError(['File is corrupted or password protected']);
  }
  const names = Object.keys(zip.files);
  if (!names.includes('[Content_Types].xml') || !names.includes(spec.requiredEntry)) {
    errors.push(`File is not a valid ${spec.ext} document (missing ${spec.requiredEntry})`);
  }
  if (names.some((n) => /vbaProject\.bin$/i.test(n))) errors.push('Macro-enabled content is not allowed');
  const total = Object.values(zip.files).reduce((s, f) => s + (f._data?.uncompressedSize || 0), 0);
  if (total > MAX_UNCOMPRESSED) errors.push('Uncompressed content too large (possible zip bomb)');
  if (errors.length) throw new FileValidationError(errors);
}

// ---------- Requirements (.docx) ----------
export async function parseRequirementsDoc(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  const paragraphs = value.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const text = paragraphs.join('\n');
  const reqIds = [...new Set((text.match(/\b(?:FR|NFR|BR|REQ|UR|SR)[-_]?\d{1,5}\b/gi) || []).map((s) => s.toUpperCase()))];
  const titleLine = paragraphs.find((p) => /^project\s*:/i.test(p));
  return {
    title: titleLine ? titleLine.replace(/^project\s*:\s*/i, '') : paragraphs[0]?.slice(0, 120) || 'Untitled',
    paragraphs,
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    requirementIds: reqIds,
  };
}

function validateRequirements(parsed) {
  const errors = [];
  const warnings = [];
  if (parsed.wordCount < 30) errors.push('Requirements document is empty or too short to analyse (< 30 words)');
  if (parsed.wordCount > 60000) errors.push('Requirements document is too large (> 60,000 words)');
  if (!parsed.requirementIds.length) warnings.push('No requirement identifiers (e.g. FR-101, NFR-201) found - IDs will be generated');
  if (!/functional/i.test(parsed.text)) warnings.push('No "Functional Requirements" section detected');
  if (!/non[- ]?functional|performance|security/i.test(parsed.text)) warnings.push('No non-functional requirements detected');
  if (!/acceptance criteria/i.test(parsed.text)) warnings.push('No acceptance criteria found - QA traceability will be weaker');
  if (!/out of scope/i.test(parsed.text)) warnings.push('No out-of-scope section found');
  return { errors, warnings };
}

// ---------- Team template (.xlsx) ----------
const KNOWN_TEAM_ROLES = ['developer', 'qa', 'architect', 'pm', 'project manager', 'ba', 'business analyst', 'designer', 'devops', 'tester', 'lead'];

export async function parseTeamSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Team') || wb.worksheets[0];
  if (!ws) return { sheet: null, members: [], headers: [] };
  const formulaCells = [];
  const cellText = (c) => {
    const v = c?.value;
    if (v == null) return '';
    if (typeof v === 'object' && (v.formula || v.sharedFormula)) { formulaCells.push(c.address); return ''; }
    if (typeof v === 'object') return String(v.text ?? v.result ?? v.richText?.map((r) => r.text).join('') ?? '');
    return String(v);
  };
  const headerRow = ws.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (c, col) => headers.push({ col, name: cellText(c).trim() }));
  const col = (name) => headers.find((h) => h.name.toLowerCase() === name)?.col;
  const map = { name: col('name'), role: col('role'), skills: col('skills'), capacity: col('capacity'), email: col('email') };
  const members = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k) => (map[k] ? cellText(row.getCell(map[k])).trim() : '');
    const name = get('name');
    if (!name && !get('role') && !get('skills')) continue;
    members.push({
      row: r,
      name,
      role: get('role'),
      skills: get('skills').split(/[,;/]+/).map((s) => s.trim()).filter(Boolean),
      capacity: get('capacity') === '' ? null : Number(get('capacity')),
      email: get('email') || null,
    });
  }
  return { sheet: ws.name, headers: headers.map((h) => h.name), members, formulaCells };
}

function validateTeam(parsed) {
  const errors = [];
  const warnings = [];
  const lower = parsed.headers.map((h) => h.toLowerCase());
  for (const h of ['name', 'role', 'skills', 'capacity']) {
    if (!lower.includes(h)) errors.push(`Missing required column "${h[0].toUpperCase() + h.slice(1)}"`);
  }
  if (!parsed.members.length) errors.push('Team sheet contains no members');
  if (parsed.formulaCells?.length) errors.push(`Formulas are not allowed in the team template (cells ${parsed.formulaCells.slice(0, 5).join(', ')})`);
  const seen = new Set();
  for (const m of parsed.members) {
    if (!m.name && !parsed.formulaCells?.some((a) => a.replace(/^[A-Z]+/, '') === String(m.row))) errors.push(`Row ${m.row}: Name is required`);
    if (/^[=+\-@]/.test(m.name)) warnings.push(`Row ${m.row}: name "${m.name.slice(0, 20)}" starts with a formula character; it will be escaped in exports`);
    if (m.capacity === 0) warnings.push(`Row ${m.row}: "${m.name}" has 0 capacity and will not be assigned work`);
    if (m.name && seen.has(m.name.toLowerCase())) errors.push(`Row ${m.row}: duplicate member "${m.name}"`);
    seen.add(m.name.toLowerCase());
    if (!m.role) errors.push(`Row ${m.row}: Role is required`);
    else if (!KNOWN_TEAM_ROLES.includes(m.role.toLowerCase())) warnings.push(`Row ${m.row}: unrecognised role "${m.role}"`);
    if (m.capacity == null || Number.isNaN(m.capacity)) errors.push(`Row ${m.row}: Capacity must be a number (hours/week)`);
    else if (m.capacity < 0 || m.capacity > 80) errors.push(`Row ${m.row}: Capacity must be between 0 and 80`);
    if (!m.skills.length) warnings.push(`Row ${m.row}: no skills listed for "${m.name}"`);
  }
  if (!parsed.members.some((m) => /developer|devops|lead/i.test(m.role))) warnings.push('No Developer in team - tasks cannot be auto-assigned');
  if (!parsed.members.some((m) => /qa|tester/i.test(m.role))) warnings.push('No QA in team - test cases cannot be auto-assigned');
  return { errors, warnings };
}

/** Validate, parse and persist an uploaded file. Returns metadata for the DB. */
export async function processUpload(kind, file) {
  if (!KINDS[kind]) throw new FileValidationError([`Unknown upload type "${kind}"`]);
  await inspectContainer(kind, file);
  let parsed;
  try {
    parsed = kind === 'requirements' ? await parseRequirementsDoc(file.buffer) : await parseTeamSheet(file.buffer);
  } catch (e) {
    throw new FileValidationError([`Could not read file content: ${e.message}`]);
  }
  const validation = kind === 'requirements' ? validateRequirements(parsed) : validateTeam(parsed);
  if (validation.errors.length) throw new FileValidationError(validation.errors);

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const storedName = `${crypto.randomUUID()}${KINDS[kind].ext}`; // never trust client file names on disk
  fs.writeFileSync(path.join(uploadDir, storedName), file.buffer, { mode: 0o600 });
  return { parsed, validation, sha256, storedName, size: file.buffer.length };
}

export function storedFilePath(storedName) {
  const safe = path.basename(storedName);
  return path.join(uploadDir, safe);
}

export function deleteStoredFile(storedName) {
  try { fs.unlinkSync(storedFilePath(storedName)); } catch { /* already gone */ }
}
