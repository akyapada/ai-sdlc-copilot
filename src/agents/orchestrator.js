// Orchestrator agent: coordinates the workflow, routes work to the right specialist,
// runs critic + guardrail + retrieval on every output and enforces the human approval gates.

import { db, json } from '../db.js';
import { config, aiEnabled } from '../config.js';
import { engineName } from '../llm.js';
import { generate, normalize } from './specialists.js';
import { review } from './critic.js';
import { scanText, reviewOutput, sanitizeDocument } from './guardrail.js';
import { buildIndex, search, collectEvidence, flattenItems } from './retrieval.js';
import { reviseWithFeedback, diffContent } from './feedback.js';
import { assignTasks, assignTests, sequenceTasks, capacitySummary, isDeveloper, isQA } from './assign.js';

export const STAGES = ['requirements', 'architecture', 'tasks', 'tests'];
export const PREV = { architecture: 'requirements', tasks: 'architecture', tests: 'tasks' };
export const STAGE_LABEL = { requirements: 'Requirements analysis', architecture: 'Architecture plan', tasks: 'Development tasks', tests: 'QA test cases' };

export class GateError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

export function rowToArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    stage: row.stage,
    version: row.version,
    status: row.status,
    source: row.source,
    engine: row.engine,
    content: json.parse(row.content_json, {}),
    critic: json.parse(row.critic_json),
    guardrail: json.parse(row.guardrail_json),
    evidence: json.parse(row.evidence_json, {}),
    changes: json.parse(row.changes_json),
    feedback: row.feedback,
    basedOn: json.parse(row.based_on_json, {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function latestArtifact(projectId, stage) {
  return rowToArtifact(db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND stage = ? ORDER BY version DESC LIMIT 1').get(projectId, stage));
}
export function approvedArtifact(projectId, stage) {
  return rowToArtifact(db.prepare("SELECT * FROM artifacts WHERE project_id = ? AND stage = ? AND status = 'APPROVED' ORDER BY version DESC LIMIT 1").get(projectId, stage));
}
export function artifactVersion(projectId, stage, version) {
  return rowToArtifact(db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND stage = ? AND version = ?').get(projectId, stage, version));
}
export function latestFile(projectId, kind) {
  const row = db.prepare('SELECT * FROM files WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1').get(projectId, kind);
  return row ? { ...row, parsed: json.parse(row.parsed_json, {}) } : null;
}

// Lightweight metadata reads (no large JSON parsing) for status checks on hot paths.
function fileMeta(projectId, kind) {
  return db.prepare('SELECT version, original_name FROM files WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1').get(projectId, kind) || null;
}
function artifactMeta(projectId, stage, approvedOnly = false) {
  const row = db.prepare(`SELECT version, status, based_on_json, json_extract(critic_json, '$.score') AS score FROM artifacts
                          WHERE project_id = ? AND stage = ? ${approvedOnly ? "AND status = 'APPROVED'" : ''} ORDER BY version DESC LIMIT 1`).get(projectId, stage);
  return row ? { version: row.version, status: row.status, basedOn: json.parse(row.based_on_json, {}), score: row.score } : null;
}

/** Current upstream versions an artefact for `stage` is built on. */
function upstreamVersions(projectId, stage) {
  const v = {};
  const reqFile = fileMeta(projectId, 'requirements');
  const teamFile = fileMeta(projectId, 'team');
  if (reqFile) v.requirementsFile = reqFile.version;
  if (teamFile && stage !== 'requirements') v.teamFile = teamFile.version;
  let s = PREV[stage];
  while (s) {
    const a = artifactMeta(projectId, s, true);
    if (a) v[s] = a.version;
    s = PREV[s];
  }
  return v;
}

export function isStale(projectId, artifact) {
  if (!artifact) return false;
  const now = upstreamVersions(projectId, artifact.stage);
  return Object.entries(artifact.basedOn || {}).some(([k, ver]) => now[k] != null && now[k] !== ver);
}

/** Gate status for every stage - drives the workflow stepper in the UI. */
export function workflowStatus(projectId) {
  const reqFile = fileMeta(projectId, 'requirements');
  const teamFile = fileMeta(projectId, 'team');
  const out = {
    files: { requirements: reqFile ? { version: reqFile.version, name: reqFile.original_name } : null, team: teamFile ? { version: teamFile.version, name: teamFile.original_name } : null },
    stages: {},
    engine: engineName(),
    aiEnabled: aiEnabled(),
  };
  const approved = Object.fromEntries(STAGES.map((s) => [s, artifactMeta(projectId, s, true)]));
  for (const stage of STAGES) {
    const latest = artifactMeta(projectId, stage);
    let blockedReason = null;
    if (!reqFile) blockedReason = 'Upload a requirements document first';
    else if (stage !== 'requirements' && !teamFile) blockedReason = 'Upload the team template first';
    else if (PREV[stage] && !approved[PREV[stage]]) blockedReason = `Waiting for ${STAGE_LABEL[PREV[stage]]} approval`;
    out.stages[stage] = {
      latestVersion: latest?.version ?? null,
      latestStatus: latest?.status ?? null,
      approvedVersion: approved[stage]?.version ?? null,
      canGenerate: !blockedReason,
      blockedReason,
      stale: latest ? isStale(projectId, { stage, basedOn: latest.basedOn }) : false,
      criticScore: latest?.score ?? null,
    };
  }
  return out;
}

function buildContext(projectId, stage) {
  const reqFile = latestFile(projectId, 'requirements');
  if (!reqFile) throw new GateError('Upload a requirements document first');
  const teamFile = latestFile(projectId, 'team');
  if (stage !== 'requirements' && !teamFile) throw new GateError('Upload the team template before generating this stage');
  // Agents only ever see the sanitised document: redacted values, injection paragraphs quarantined.
  const { doc, findings } = sanitizeDocument(reqFile.parsed);
  const ctx = { doc, docFindings: findings, team: teamFile?.parsed?.members || [] };
  let s = PREV[stage];
  while (s) {
    const a = approvedArtifact(projectId, s);
    if (!a) throw new GateError(`Gate closed: ${STAGE_LABEL[s]} must be approved before generating ${STAGE_LABEL[stage].toLowerCase()}`);
    ctx[s] = a.content;
    s = PREV[s];
  }
  if (!ctx.requirements) ctx.requirements = null;
  return ctx;
}

function postProcess(stage, content, ctx, { preserveAssignments = false } = {}) {
  if (stage === 'tasks') {
    sequenceTasks(content.tasks);
    content.tasks.sort((a, b) => a.sequence - b.sequence);
    content.capacity = preserveAssignments
      ? assignTasks(content.tasks, ctx.team, { onlyUnassigned: true })
      : assignTasks(content.tasks, ctx.team);
  }
  if (stage === 'tests') {
    const tasks = ctx.tasks?.tasks || [];
    for (const t of content.testCases) {
      if (!t.taskRefs.length) t.taskRefs = tasks.filter((k) => k.reqRefs.some((r) => t.reqRefs.includes(r))).map((k) => k.id).slice(0, 4);
    }
    content.capacity = assignTests(content.testCases, ctx.team, { onlyUnassigned: preserveAssignments });
  }
  return content;
}

function knownReqIds(stage, content, ctx) {
  const r = stage === 'requirements' ? content : ctx.requirements;
  return [...(r?.functional || []), ...(r?.nonFunctional || [])].map((x) => x.id);
}

async function finalize(projectId, stage, content, ctx, meta) {
  const index = buildIndex(ctx.doc.paragraphs || []);
  const critic = await review(stage, content, ctx);
  const output = reviewOutput(stage, content, knownReqIds(stage, content, ctx));
  const guardrail = { input: meta.inputFindings || [], output: output.findings, passed: output.passed && !(meta.inputFindings || []).some((f) => f.severity === 'high') };
  const evidence = collectEvidence(index, flattenItems(stage, content));
  const prev = latestArtifact(projectId, stage);
  const changes = { diff: diffContent(stage, prev?.content, content), changeLog: meta.changeLog || [], selfRevision: meta.selfRevision || null, note: meta.note || null };

  const version = (prev?.version || 0) + 1;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE artifacts SET status = 'SUPERSEDED' WHERE project_id = ? AND stage = ? AND status = 'IN_REVIEW'").run(projectId, stage);
    db.prepare(`INSERT INTO artifacts (project_id, stage, version, status, source, content_json, critic_json, guardrail_json, evidence_json, changes_json, feedback, based_on_json, engine, created_by)
                VALUES (?, ?, ?, 'IN_REVIEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      projectId, stage, version, meta.source, json.str(content), json.str(critic), json.str(guardrail), json.str(evidence), json.str(changes),
      meta.feedback || null, json.str(upstreamVersions(projectId, stage)), meta.engine, meta.userId,
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return artifactVersion(projectId, stage, version);
}

/** Generate a fresh artefact for a stage (specialist agent + self-review loop). */
export async function runStage(projectId, stage, userId) {
  const ctx = buildContext(projectId, stage);
  const inputFindings = ctx.docFindings;
  ctx.redactedText = ctx.doc.text;
  const index = buildIndex(ctx.doc.paragraphs || []);
  if (stage !== 'requirements') {
    const q = flattenItems('requirements', ctx.requirements).map((r) => r.title).join(' ');
    ctx.evidence = search(index, q, 6);
  }

  let { content, engine, note } = await generate(stage, ctx);
  content = postProcess(stage, content, ctx);

  // Self-correction: if the critic is unhappy and a model is available, revise once automatically.
  let selfRevision = null;
  if (aiEnabled() && !engine.includes('fallback')) {
    const first = await review(stage, content, ctx);
    if (first.score < config.criticSelfReviseThreshold) {
      const r = await reviseWithFeedback(stage, content, { feedback: 'Resolve the critic findings.', criticIssues: first.issues, addressCritic: true, ctx });
      content = postProcess(stage, r.content, ctx, { preserveAssignments: true });
      selfRevision = { scoreBefore: first.score, changeLog: r.changeLog };
    }
  }
  return finalize(projectId, stage, content, ctx, { source: 'ai', engine, note, inputFindings, selfRevision, userId });
}

/** Review-feedback agent: regenerate a new version from reviewer suggestions. */
export async function regenerateWithFeedback(projectId, stage, { baseVersion, feedback, addressCritic, userId }) {
  const base = baseVersion ? artifactVersion(projectId, stage, baseVersion) : latestArtifact(projectId, stage);
  if (!base) throw new GateError('Nothing to revise - generate this stage first', 404);
  const ctx = buildContext(projectId, stage);
  const { findings: fbFindings } = scanText(feedback || '', 'reviewer feedback');
  if (fbFindings.some((f) => f.type === 'PROMPT_INJECTION')) throw new GateError('Feedback looks like instructions to override the AI (prompt injection) and was rejected', 422);
  const inputFindings = [...ctx.docFindings, ...fbFindings];
  const r = await reviseWithFeedback(stage, base.content, { feedback, criticIssues: base.critic?.issues || [], addressCritic, ctx });
  const content = postProcess(stage, r.content, ctx, { preserveAssignments: true });
  return finalize(projectId, stage, content, ctx, {
    source: 'ai-feedback', engine: engineName(), feedback, changeLog: r.changeLog, inputFindings, userId,
    note: `Revision of v${base.version}`,
  });
}

/** Human edit: saves edited content as a new version, re-running critic/guardrail but no LLM. */
export async function saveHumanEdit(projectId, stage, { content, userId, comment }) {
  const ctx = buildContext(projectId, stage);
  let normalized = normalize(stage, content, ctx);
  if (stage === 'tasks') {
    sequenceTasks(normalized.tasks);
    normalized.capacity = capacitySummary(normalized.tasks, ctx.team.filter(isDeveloper), 'estimateHours');
  }
  if (stage === 'tests') normalized.capacity = capacitySummary(normalized.testCases, ctx.team.filter(isQA), 'estimateHours');
  return finalize(projectId, stage, normalized, ctx, { source: 'human-edit', engine: 'human', feedback: comment, changeLog: [{ change: 'Manual edit', reason: comment || 'Edited by reviewer' }], userId });
}

/** Approval gate decision. */
export function decide(projectId, stage, version, { decision, comments, acknowledgeRisks, user }) {
  const art = artifactVersion(projectId, stage, version);
  if (!art) throw new GateError('Artefact version not found', 404);
  if (art.status !== 'IN_REVIEW') throw new GateError(`Version ${version} is ${art.status} and cannot be ${decision.toLowerCase()}`);
  if (decision === 'APPROVED') {
    if (isStale(projectId, art)) throw new GateError('Upstream inputs changed since this version was generated - regenerate before approving');
    const high = [...(art.guardrail?.input || []), ...(art.guardrail?.output || [])].filter((f) => f.severity === 'high');
    const conflicts = art.content.conflicts || [];
    if (conflicts.length && !acknowledgeRisks) throw new GateError(`${conflicts.length} unresolved conflict(s) (${conflicts.map((c) => c.id).join(', ')}). Resolve them via the feedback agent, or acknowledge with a comment to approve.`, 422);
    if (high.length && !acknowledgeRisks) throw new GateError(`Guardrail raised ${high.length} high-severity finding(s). Review them and tick "acknowledge" with a comment to approve.`, 422);
    if ((high.length || conflicts.length) && !comments) throw new GateError('A comment is required when approving with acknowledged risks or conflicts', 422);
  }
  if (decision === 'REJECTED' && !comments) throw new GateError('A rejection reason is required', 422);
  db.exec('BEGIN');
  try {
    if (decision === 'APPROVED') {
      db.prepare("UPDATE artifacts SET status = 'SUPERSEDED' WHERE project_id = ? AND stage = ? AND status = 'APPROVED'").run(projectId, stage);
    }
    db.prepare('UPDATE artifacts SET status = ? WHERE id = ?').run(decision, art.id);
    db.prepare('INSERT INTO reviews (artifact_id, reviewer_id, reviewer_name, decision, comments) VALUES (?, ?, ?, ?, ?)').run(art.id, user.id, user.name, decision, comments || null);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return artifactVersion(projectId, stage, version);
}

/** Requirement -> task -> test traceability using the latest approved (or latest) versions. */
export function traceability(projectId) {
  const pick = (s) => approvedArtifact(projectId, s) || latestArtifact(projectId, s);
  const req = pick('requirements')?.content;
  const arch = pick('architecture')?.content;
  const tasks = pick('tasks')?.content?.tasks || [];
  const tests = pick('tests')?.content?.testCases || [];
  if (!req) return { rows: [], summary: null };
  const rows = [...req.functional, ...req.nonFunctional].map((r) => {
    const comps = (arch?.components || []).filter((c) => c.reqRefs.includes(r.id)).map((c) => c.id);
    const t = tasks.filter((k) => k.reqRefs.includes(r.id)).map((k) => k.id);
    const tc = tests.filter((k) => k.reqRefs.includes(r.id));
    return {
      reqId: r.id,
      title: r.title,
      components: comps,
      tasks: t,
      tests: tc.map((k) => k.id),
      testTypes: [...new Set(tc.map((k) => k.type))],
      covered: Boolean(t.length && tc.length),
    };
  });
  return {
    rows,
    summary: { requirements: rows.length, withTasks: rows.filter((r) => r.tasks.length).length, withTests: rows.filter((r) => r.tests.length).length, fullyCovered: rows.filter((r) => r.covered).length },
  };
}
