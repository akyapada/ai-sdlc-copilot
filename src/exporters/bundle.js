import ExcelJS from 'exceljs';
import { db } from '../db.js';
import { STAGES, approvedArtifact, latestArtifact, traceability } from '../agents/orchestrator.js';

/** Collect the best available version of every stage (approved first, else latest draft). */
export function collectBundle(projectId, { approvedOnly = false } = {}) {
  const project = db.prepare('SELECT id, name, description, created_at FROM projects WHERE id = ?').get(projectId);
  const stages = {};
  for (const s of STAGES) {
    const a = approvedArtifact(projectId, s) || (approvedOnly ? null : latestArtifact(projectId, s));
    if (a) stages[s] = { version: a.version, status: a.status, content: a.content, critic: a.critic };
  }
  const reviews = db.prepare(`SELECT a.stage, a.version, r.decision, r.reviewer_name, r.comments, r.created_at
                              FROM reviews r JOIN artifacts a ON a.id = r.artifact_id WHERE a.project_id = ? ORDER BY r.created_at`).all(projectId);
  return { project, generatedAt: new Date().toISOString(), stages, traceability: traceability(projectId), reviews };
}

const j = (v) => (Array.isArray(v) ? v.join('\n') : v ?? '');

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map(([header, key, width = 22]) => ({ header, key, width }));
  for (const r of rows) ws.addRow(Object.fromEntries(columns.map(([, key]) => [key, j(r[key])])));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  ws.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

export async function toExcel(bundle) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI SDLC Copilot';
  const { stages } = bundle;
  addSheet(wb, 'Summary', [['Item', 'k', 30], ['Value', 'v', 80]], [
    { k: 'Project', v: bundle.project.name },
    { k: 'Generated', v: bundle.generatedAt },
    ...Object.entries(stages).map(([s, a]) => ({ k: `${s} version`, v: `v${a.version} (${a.status}) - critic score ${a.critic?.score ?? 'n/a'}` })),
    ...(bundle.traceability.summary ? [{ k: 'Requirements fully covered', v: `${bundle.traceability.summary.fullyCovered} / ${bundle.traceability.summary.requirements}` }] : []),
  ]);
  const req = stages.requirements?.content;
  if (req) {
    addSheet(wb, 'Requirements', [['ID', 'id', 10], ['Type', 'type', 12], ['Category', 'category', 14], ['Title', 'title', 35], ['Description', 'description', 60], ['Acceptance criteria', 'acceptanceCriteria', 60], ['Metric', 'metric', 20], ['Priority', 'priority', 10]],
      [...req.functional.map((r) => ({ ...r, type: 'Functional' })), ...req.nonFunctional.map((r) => ({ ...r, type: 'Non-functional' }))]);
    addSheet(wb, 'Analysis', [['ID', 'id', 8], ['Kind', 'kind', 14], ['Ref', 'ref', 10], ['Finding', 'text', 70], ['Question / recommendation / mitigation', 'extra', 70], ['Severity', 'severity', 10]], [
      ...req.ambiguities.map((x) => ({ ...x, kind: 'Ambiguity', extra: x.question })),
      ...req.gaps.map((x) => ({ ...x, kind: 'Gap', extra: x.recommendation })),
      ...req.dependencies.map((x) => ({ ...x, kind: 'Dependency', extra: x.name })),
      ...req.risks.map((x) => ({ ...x, kind: 'Risk', extra: x.mitigation })),
      ...req.assumptions.map((x) => ({ ...x, kind: 'Assumption' })),
    ]);
  }
  const arch = stages.architecture?.content;
  if (arch) {
    addSheet(wb, 'Architecture', [['ID', 'id', 8], ['Component', 'name', 30], ['Category', 'category', 14], ['Responsibility', 'responsibility', 60], ['Technology', 'technology', 30], ['Requirements', 'reqRefs', 20]], arch.components);
    addSheet(wb, 'Security', [['ID', 'id', 8], ['Concern', 'concern', 30], ['Control', 'control', 70], ['Requirements', 'reqRefs', 20]], arch.security);
  }
  const tasks = stages.tasks?.content?.tasks;
  if (tasks) {
    addSheet(wb, 'Dev Tasks', [['ID', 'id', 8], ['Seq', 'sequence', 6], ['Title', 'title', 45], ['Type', 'type', 12], ['Component', 'componentRef', 10], ['Requirements', 'reqRefs', 14], ['Depends on', 'dependsOn', 14], ['Skills', 'skills', 24], ['Complexity', 'complexity', 10], ['Est. hours', 'estimateHours', 10], ['Priority', 'priority', 8], ['Assignee', 'assignee', 16], ['Status', 'status', 10]], tasks);
  }
  const tests = stages.tests?.content?.testCases;
  if (tests) {
    addSheet(wb, 'Test Cases', [['ID', 'id', 9], ['Title', 'title', 45], ['Type', 'type', 12], ['Requirements', 'reqRefs', 14], ['Tasks', 'taskRefs', 14], ['Preconditions', 'preconditions', 30], ['Steps', 'steps', 50], ['Expected', 'expected', 45], ['Priority', 'priority', 9], ['Assignee', 'assignee', 16], ['Status', 'status', 10]], tests);
  }
  addSheet(wb, 'Traceability', [['Requirement', 'reqId', 12], ['Title', 'title', 40], ['Components', 'components', 18], ['Tasks', 'tasks', 30], ['Tests', 'tests', 40], ['Test types', 'testTypes', 30], ['Covered', 'covered', 10]], bundle.traceability.rows.map((r) => ({ ...r, covered: r.covered ? 'Yes' : 'NO' })));
  addSheet(wb, 'Approvals', [['Stage', 'stage', 14], ['Version', 'version', 8], ['Decision', 'decision', 12], ['Reviewer', 'reviewer_name', 24], ['Comments', 'comments', 60], ['Timestamp (UTC)', 'created_at', 20]], bundle.reviews);
  return wb.xlsx.writeBuffer();
}

const csvCell = (v) => {
  let s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV/formula injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

/** Jira CSV importer format: Epic per requirement, Story/Task per task, test cases as Tasks with label. */
export function toJiraCsv(bundle) {
  const rows = [['Issue Id', 'Parent Id', 'Issue Type', 'Summary', 'Description', 'Priority', 'Labels', 'Original Estimate', 'Assignee']];
  const req = bundle.stages.requirements?.content;
  const reqIndex = {};
  let n = 1;
  for (const r of [...(req?.functional || []), ...(req?.nonFunctional || [])]) {
    reqIndex[r.id] = n;
    rows.push([n++, '', 'Epic', `${r.id} ${r.title}`, [r.description, ...(r.acceptanceCriteria || []).map((a) => `AC: ${a}`)].join('\n'), 'High', 'ai-sdlc requirement', '', '']);
  }
  const prio = { P1: 'High', P2: 'Medium', P3: 'Low' };
  for (const t of bundle.stages.tasks?.content?.tasks || []) {
    rows.push([n++, reqIndex[t.reqRefs[0]] || '', 'Story', `${t.id} ${t.title}`, `${t.description}\nDepends on: ${t.dependsOn.join(', ') || '-'}\nSkills: ${t.skills.join(', ')}`, prio[t.priority] || 'Medium', `ai-sdlc dev-task ${t.type}`, `${t.estimateHours}h`, t.assignee]);
  }
  for (const t of bundle.stages.tests?.content?.testCases || []) {
    rows.push([n++, reqIndex[t.reqRefs[0]] || '', 'Task', `${t.id} [${t.type}] ${t.title}`, `Preconditions: ${t.preconditions}\nSteps:\n${t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nExpected: ${t.expected}`, t.priority, `ai-sdlc test-case ${t.type}`, '', t.assignee]);
  }
  return toCsv(rows);
}

/** Azure DevOps "Import work items" CSV with hierarchy columns (Title 1 = parent, Title 2 = child). */
export function toAdoCsv(bundle) {
  const rows = [['ID', 'Work Item Type', 'Title 1', 'Title 2', 'Description', 'Priority', 'Tags', 'Original Estimate', 'Assigned To']];
  const req = bundle.stages.requirements?.content;
  const tasks = bundle.stages.tasks?.content?.tasks || [];
  const tests = bundle.stages.tests?.content?.testCases || [];
  for (const r of [...(req?.functional || []), ...(req?.nonFunctional || [])]) {
    rows.push(['', 'User Story', `${r.id} ${r.title}`, '', [r.description, ...(r.acceptanceCriteria || []).map((a) => `AC: ${a}`)].join('\n'), 1, 'ai-sdlc; requirement', '', '']);
    for (const t of tasks.filter((x) => x.reqRefs[0] === r.id)) rows.push(['', 'Task', '', `${t.id} ${t.title}`, t.description, { P1: 1, P2: 2, P3: 3 }[t.priority] || 2, `ai-sdlc; ${t.type}`, t.estimateHours, t.assignee]);
    for (const t of tests.filter((x) => x.reqRefs[0] === r.id)) rows.push(['', 'Test Case', '', `${t.id} [${t.type}] ${t.title}`, `${t.steps.join('\n')}\nExpected: ${t.expected}`, t.priority === 'High' ? 1 : 2, `ai-sdlc; test; ${t.type}`, '', t.assignee]);
  }
  return toCsv(rows);
}

export function toMarkdown(bundle) {
  const out = [`# ${bundle.project.name} - AI SDLC Report`, `Generated ${bundle.generatedAt}`, ''];
  const req = bundle.stages.requirements?.content;
  if (req) {
    out.push(`## Requirements (v${bundle.stages.requirements.version}, ${bundle.stages.requirements.status})`, req.summary, '');
    for (const r of req.functional) out.push(`- **${r.id} ${r.title}** - ${r.description}`, ...r.acceptanceCriteria.map((a) => `  - AC: ${a}`));
    for (const r of req.nonFunctional) out.push(`- **${r.id} ${r.title}** (${r.category}) ${r.metric ? `- ${r.metric}` : ''}`);
    out.push('', '### Ambiguities', ...req.ambiguities.map((a) => `- ${a.id} [${a.ref}] ${a.question}`), '', '### Gaps', ...req.gaps.map((g) => `- ${g.id} (${g.severity}) ${g.text}`), '', '### Risks', ...req.risks.map((r) => `- ${r.id} (${r.severity}) ${r.text} - _${r.mitigation}_`), '');
  }
  const arch = bundle.stages.architecture?.content;
  if (arch) {
    out.push(`## Architecture (v${bundle.stages.architecture.version}, ${bundle.stages.architecture.status})`, arch.overview, '', '| ID | Component | Technology | Reqs |', '|---|---|---|---|');
    for (const c of arch.components) out.push(`| ${c.id} | ${c.name} | ${c.technology} | ${c.reqRefs.join(', ')} |`);
    out.push('', '### Security', ...arch.security.map((s) => `- **${s.concern}**: ${s.control}`), '', '### Open questions', ...arch.openQuestions.map((q) => `- ${q}`), '');
  }
  const tasks = bundle.stages.tasks?.content?.tasks;
  if (tasks) {
    out.push('## Development tasks', '| ID | Title | Est | Assignee | Depends |', '|---|---|---|---|---|');
    for (const t of tasks) out.push(`| ${t.id} | ${t.title} | ${t.estimateHours}h | ${t.assignee} | ${t.dependsOn.join(', ')} |`);
    out.push('');
  }
  const tests = bundle.stages.tests?.content?.testCases;
  if (tests) {
    out.push('## Test cases', '| ID | Type | Title | Reqs | Assignee |', '|---|---|---|---|---|');
    for (const t of tests) out.push(`| ${t.id} | ${t.type} | ${t.title} | ${t.reqRefs.join(', ')} | ${t.assignee} |`);
  }
  return out.join('\n');
}
