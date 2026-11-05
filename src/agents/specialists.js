// Specialist agents: requirements analyst, solution architect, delivery planner, QA designer.
// Each uses Azure OpenAI when configured and falls back to the offline engine otherwise.

import { aiEnabled } from '../config.js';
import { chatJSON, engineName } from '../llm.js';
import * as mock from './mock.js';
import { skillsFor } from './assign.js';

const SCHEMAS = {
  requirements: `{
 "summary": string,
 "functional": [{"id":"FR-101","title":string,"description":string,"details":[string],"acceptanceCriteria":[string],"priority":"Must|Should|Could"}],
 "nonFunctional": [{"id":"NFR-201","category":"Performance|Security|Compliance|Availability|Scalability|Usability|Other","title":string,"description":string,"metric":string,"priority":"Must|Should|Could"}],
 "constraints": [{"id":"CON-01","text":string}],
 "outOfScope": [string],
 "conflicts": [{"id":"X-01","refs":[string],"text":"<statements that contradict each other or policy>","question":string}],
 "ambiguities": [{"id":"A-01","ref":"<req id>","text":string,"question":string}],
 "dependencies": [{"id":"D-01","ref":"<req id>","refs":[string],"name":string,"type":"External|Internal","text":string}],
 "gaps": [{"id":"G-01","ref":"<req id or GENERAL>","text":string,"recommendation":string,"severity":"High|Medium|Low"}],
 "assumptions": [{"id":"AS-01","text":string}],
 "risks": [{"id":"R-01","ref":string,"text":string,"severity":"High|Medium|Low","mitigation":string}]
}`,
  architecture: `{
 "overview": string,
 "components": [{"id":"C-01","name":string,"responsibility":string,"technology":string,"category":"Frontend|Backend|Database|Integration|Security|DevOps|Performance","reqRefs":[string]}],
 "interactions": [{"from":"C-01","to":"C-02","description":string,"protocol":string}],
 "integrationPoints": [{"id":"IP-01","name":string,"type":string,"description":string,"reqRefs":[string],"failureHandling":string}],
 "dataFlows": [{"id":"DF-01","name":string,"reqRefs":[string],"steps":[string]}],
 "technology": [{"area":string,"choice":string,"rationale":string}],
 "security": [{"id":"S-01","concern":string,"control":string,"reqRefs":[string]}],
 "assumptions": [string],
 "openQuestions": [string]
}`,
  tasks: `{
 "tasks": [{"id":"T-001","title":string,"description":string,"type":"Backend|Frontend|DevOps|Security|Database|Integration|Performance","componentRef":"C-01","reqRefs":[string],"dependsOn":["T-000"],"skills":[string],"complexity":"S|M|L|XL","estimateHours":number,"priority":"P1|P2|P3","acceptanceCriteria":[string],"status":"To Do"}],
 "sequencingNotes": string
}`,
  tests: `{
 "testCases": [{"id":"TC-001","title":string,"type":"Positive|Negative|Boundary|Integration|Regression|Security|Usability|Performance","reqRefs":[string],"taskRefs":[string],"preconditions":string,"steps":[string],"expected":string,"priority":"High|Medium|Low","status":"Draft"}]
}`,
};

export const STAGE_SCHEMAS = SCHEMAS;

const ROLES = {
  requirements: 'You are a senior business analyst. Analyse the requirements document. Keep the document\'s own requirement IDs; invent IDs (FR-xxx / NFR-xxx) only if missing. Identify functional and non-functional requirements, conflicts (contradictory statements, in-scope vs out-of-scope clashes, requirements violating security/compliance policy), duplicate or missing requirement IDs, references to requirements that do not exist, ambiguities (vague terms, undefined boundaries), dependencies, gaps, assumptions and risks. Only state what the document supports; mark inferences as assumptions.',
  architecture: 'You are a principal software architect. Produce an initial architecture plan for the approved requirements: components, interactions (using component IDs), integration points, data flows, technology considerations aligned to the team\'s skills, security considerations, key assumptions and open questions. Every component and security control must reference the requirement IDs it satisfies (reqRefs).',
  tasks: 'You are a delivery lead. Break the approved architecture into development tasks with dependencies (dependsOn task IDs), sequencing, required skills (prefer the team\'s listed skills), relative complexity and an hour estimate. Every task must reference requirement IDs (reqRefs) and one component (componentRef). Do NOT assign people - assignment is done by the platform.',
  tests: 'You are a QA lead. Generate test cases from the approved requirements, architecture and development tasks, including positive, negative, boundary, integration, regression, security, usability and performance scenarios where relevant. Every acceptance criterion must have at least one test. Each test references requirement IDs (reqRefs) and task IDs (taskRefs). Do NOT assign people.',
};

function teamBrief(team) {
  return team.map((m) => `- ${m.name} (${m.role}, ${m.capacity}h): ${m.skills.join(', ')}`).join('\n');
}

function buildPrompt(stage, ctx) {
  const parts = [`Return JSON exactly matching this schema:\n${SCHEMAS[stage]}`];
  if (stage === 'requirements') parts.push(`<document title="${ctx.doc.title}">\n${ctx.redactedText}\n</document>`);
  else parts.push(`<input name="approved-requirements">\n${JSON.stringify(ctx.requirements)}\n</input>`);
  if (stage === 'tasks' || stage === 'tests') parts.push(`<input name="approved-architecture">\n${JSON.stringify(ctx.architecture)}\n</input>`);
  if (stage === 'tests') parts.push(`<input name="approved-tasks">\n${JSON.stringify(ctx.tasks.tasks.map(({ id, title, reqRefs, acceptanceCriteria }) => ({ id, title, reqRefs, acceptanceCriteria })))}\n</input>`);
  if (stage === 'architecture' || stage === 'tasks') parts.push(`<input name="team">\n${teamBrief(ctx.team)}\n</input>`);
  if (ctx.evidence?.length) parts.push(`<input name="retrieved-evidence">\n${ctx.evidence.map((e) => `[${e.chunk.id}${e.chunk.reqId ? ` ${e.chunk.reqId}` : ''}] ${e.chunk.text.slice(0, 500)}`).join('\n')}\n</input>`);
  return parts.join('\n\n');
}

function mockGenerate(stage, ctx) {
  if (stage === 'requirements') return mock.analyzeRequirements(ctx.doc);
  if (stage === 'architecture') return mock.draftArchitecture(ctx.requirements, ctx.team, ctx.doc?.title);
  if (stage === 'tasks') return mock.planTasks(ctx.requirements, ctx.architecture, ctx.team);
  return mock.generateTests(ctx.requirements, ctx.architecture, ctx.tasks);
}

/** Run the specialist agent for a stage. Returns { content, engine, note }. */
export async function generate(stage, ctx) {
  if (aiEnabled()) {
    try {
      const raw = await chatJSON({ system: ROLES[stage], user: buildPrompt(stage, ctx) });
      return { content: normalize(stage, raw, ctx), engine: engineName() };
    } catch (e) {
      console.error(`[agent:${stage}] LLM failed, falling back to offline engine:`, e.message);
      return { content: normalize(stage, mockGenerate(stage, ctx), ctx), engine: 'offline-mock (fallback)', note: `AI service error: ${e.message}` };
    }
  }
  return { content: normalize(stage, mockGenerate(stage, ctx), ctx), engine: engineName() };
}

const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const strArr = (v) => arr(v).map((x) => (typeof x === 'string' ? x : x?.text || JSON.stringify(x)));

function ensureIds(items, prefix, width = 2) {
  const used = new Set();
  return items.map((it, i) => {
    let id = it.id && !used.has(it.id) ? String(it.id) : `${prefix}-${String(i + 1).padStart(width, '0')}`;
    while (used.has(id)) id = `${id}x`;
    used.add(id);
    return { ...it, id };
  });
}

/** Coerce model/edited output into the stage schema so downstream code can rely on shapes. */
export function normalize(stage, c, ctx = {}) {
  c = c && typeof c === 'object' ? c : {};
  if (stage === 'requirements') {
    return {
      summary: String(c.summary || ''),
      functional: ensureIds(arr(c.functional), 'FR', 3).map((r) => ({ ...r, title: String(r.title || ''), description: String(r.description || ''), details: strArr(r.details), acceptanceCriteria: strArr(r.acceptanceCriteria), priority: r.priority || 'Must' })),
      nonFunctional: ensureIds(arr(c.nonFunctional), 'NFR', 3).map((r) => ({ ...r, category: r.category || 'Other', title: String(r.title || ''), description: String(r.description || ''), metric: String(r.metric || ''), priority: r.priority || 'Must' })),
      constraints: ensureIds(arr(c.constraints).map((x) => (typeof x === 'string' ? { text: x } : x)), 'CON'),
      outOfScope: strArr(c.outOfScope),
      conflicts: ensureIds(arr(c.conflicts), 'X').map((x) => ({ ...x, refs: strArr(x.refs) })),
      ambiguities: ensureIds(arr(c.ambiguities), 'A'),
      dependencies: ensureIds(arr(c.dependencies), 'D').map((d) => ({ ...d, refs: strArr(d.refs?.length ? d.refs : d.ref ? [d.ref] : []) })),
      gaps: ensureIds(arr(c.gaps), 'G'),
      assumptions: ensureIds(arr(c.assumptions).map((x) => (typeof x === 'string' ? { text: x } : x)), 'AS'),
      risks: ensureIds(arr(c.risks), 'R'),
      reviewerNotes: strArr(c.reviewerNotes),
    };
  }
  if (stage === 'architecture') {
    return {
      overview: String(c.overview || ''),
      components: ensureIds(arr(c.components), 'C').map((x) => ({ ...x, name: String(x.name || x.id), reqRefs: strArr(x.reqRefs), category: x.category || 'Backend' })),
      interactions: arr(c.interactions),
      integrationPoints: ensureIds(arr(c.integrationPoints), 'IP').map((x) => ({ ...x, reqRefs: strArr(x.reqRefs) })),
      dataFlows: ensureIds(arr(c.dataFlows), 'DF').map((x) => ({ ...x, reqRefs: strArr(x.reqRefs), steps: strArr(x.steps) })),
      technology: arr(c.technology),
      security: ensureIds(arr(c.security), 'S').map((x) => ({ ...x, reqRefs: strArr(x.reqRefs) })),
      assumptions: strArr(c.assumptions),
      openQuestions: strArr(c.openQuestions),
      reviewerNotes: strArr(c.reviewerNotes),
    };
  }
  if (stage === 'tasks') {
    const team = ctx.team || [];
    return {
      tasks: ensureIds(arr(c.tasks), 'T', 3).map((t) => ({
        ...t,
        title: String(t.title || ''),
        type: t.type || 'Backend',
        reqRefs: strArr(t.reqRefs),
        dependsOn: strArr(t.dependsOn),
        skills: strArr(t.skills).length ? strArr(t.skills) : skillsFor(t.type || 'Backend', team),
        complexity: t.complexity || 'M',
        estimateHours: Number(t.estimateHours) || { S: 4, M: 8, L: 16, XL: 24 }[t.complexity] || 8,
        priority: t.priority || 'P2',
        acceptanceCriteria: strArr(t.acceptanceCriteria),
        assignee: t.assignee || '',
        status: t.status || 'To Do',
      })),
      sequencingNotes: String(c.sequencingNotes || ''),
      capacity: arr(c.capacity),
      reviewerNotes: strArr(c.reviewerNotes),
    };
  }
  return {
    testCases: ensureIds(arr(c.testCases), 'TC', 3).map((t) => ({
      ...t,
      title: String(t.title || ''),
      type: t.type || 'Positive',
      reqRefs: strArr(t.reqRefs),
      taskRefs: strArr(t.taskRefs),
      preconditions: String(t.preconditions || ''),
      steps: strArr(t.steps),
      expected: String(t.expected || ''),
      priority: t.priority || 'Medium',
      assignee: t.assignee || '',
      status: t.status || 'Draft',
    })),
    capacity: arr(c.capacity),
    reviewerNotes: strArr(c.reviewerNotes),
  };
}
