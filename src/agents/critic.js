// Review / critic agent: checks outputs for gaps, inconsistencies, risks and alignment with requirements.
// Deterministic checks always run; with Azure OpenAI an additional qualitative review is merged in.

import { aiEnabled } from '../config.js';
import { chatJSON } from '../llm.js';
import { sequenceTasks } from './assign.js';

const REQUIRED_TEST_TYPES = ['Positive', 'Negative', 'Boundary', 'Integration', 'Regression', 'Security', 'Usability'];

function reqIds(requirements) {
  return [...(requirements?.functional || []), ...(requirements?.nonFunctional || [])].map((r) => r.id);
}

function coverage(ids, items) {
  const covered = new Set(items.flatMap((i) => i.reqRefs || []));
  return ids.filter((id) => !covered.has(id));
}

export function deterministicReview(stage, content, ctx) {
  const issues = [];
  const add = (severity, category, message, ref = null) => issues.push({ severity, category, message, ref });
  const ids = reqIds(stage === 'requirements' ? content : ctx.requirements);

  if (stage === 'requirements') {
    if (!content.functional.length) add('high', 'Completeness', 'No functional requirements identified');
    for (const x of content.conflicts || []) add('high', 'Conflict', `${x.id}: ${x.text}`, x.refs?.[0] || null);
    for (const r of content.functional) if (!r.acceptanceCriteria.length) add('medium', 'Testability', `${r.id} has no acceptance criteria`, r.id);
    for (const r of content.nonFunctional) if (!r.metric) add('low', 'Measurability', `${r.id} has no measurable metric`, r.id);
    if (content.ambiguities.length) add('medium', 'Clarity', `${content.ambiguities.length} ambiguities need clarification before approval`);
    const highGaps = content.gaps.filter((g) => /high/i.test(g.severity));
    if (highGaps.length) add('medium', 'Gaps', `${highGaps.length} high-severity gaps: ${highGaps.map((g) => g.id).join(', ')}`);
  }

  if (stage === 'architecture') {
    for (const id of coverage(ids, content.components)) add('high', 'Traceability', `Requirement ${id} is not addressed by any component`, id);
    const compIds = new Set(content.components.map((c) => c.id));
    for (const i of content.interactions) {
      if (!compIds.has(i.from) || !compIds.has(i.to)) add('medium', 'Consistency', `Interaction ${i.from} -> ${i.to} references an unknown component`);
    }
    if (!content.security.length) add('high', 'Security', 'No security considerations defined');
    const nfrSec = (ctx.requirements?.nonFunctional || []).filter((n) => ['Security', 'Compliance'].includes(n.category)).map((n) => n.id);
    for (const id of nfrSec) if (!content.security.some((s) => s.reqRefs.includes(id))) add('high', 'Security', `Security NFR ${id} has no explicit control`, id);
    for (const ip of content.integrationPoints) if (!ip.failureHandling) add('medium', 'Resilience', `Integration ${ip.name} has no failure handling`, ip.id);
    if (content.openQuestions.length) add('low', 'Open questions', `${content.openQuestions.length} open questions remain`);
  }

  if (stage === 'tasks') {
    for (const id of coverage(ids, content.tasks)) add('high', 'Traceability', `Requirement ${id} has no development task`, id);
    const taskIds = new Set(content.tasks.map((t) => t.id));
    for (const t of content.tasks) {
      for (const d of t.dependsOn) if (!taskIds.has(d)) add('medium', 'Consistency', `${t.id} depends on unknown task ${d}`, t.id);
      if (!t.assignee) add('medium', 'Assignment', `${t.id} is unassigned`, t.id);
    }
    const gaps = content.tasks.filter((t) => t.skillGap);
    if (gaps.length) add('high', 'Skill gap', `${gaps.length} task(s) need skills nobody on the team has (${[...new Set(gaps.flatMap((t) => t.skills))].slice(0, 5).join(', ')}): ${gaps.slice(0, 6).map((t) => t.id).join(', ')}`);
    for (const m of (content.capacity || []).filter((x) => x.capacity === 0)) add(m.assignedHours > 0 ? 'high' : 'low', 'Capacity', m.assignedHours > 0 ? `${m.name} has 0 capacity but ${m.assignedHours}h assigned` : `${m.name} has 0 capacity and was excluded from assignment`);
    const { cycles } = sequenceTasks(content.tasks.map((t) => ({ ...t })));
    for (const c of cycles) add('high', 'Sequencing', `Dependency cycle: ${c}`);
    const cap = (content.capacity || []).filter((m) => m.weeksOfWork != null);
    if (cap.length > 1) {
      const max = cap.reduce((a, b) => (b.weeksOfWork > a.weeksOfWork ? b : a));
      const min = cap.reduce((a, b) => (b.weeksOfWork < a.weeksOfWork ? b : a));
      if (max.weeksOfWork > Math.max(1, min.weeksOfWork * 1.75)) add('medium', 'Capacity', `Workload imbalance: ${max.name} has ${max.weeksOfWork} weeks of work vs ${min.name} ${min.weeksOfWork} weeks`);
      add('low', 'Capacity', `Backlog needs ~${Math.ceil(max.weeksOfWork)} week(s) at current team capacity (critical path: ${max.name})`);
    }
  }

  if (stage === 'tests') {
    for (const id of coverage(ids, content.testCases)) add('high', 'Traceability', `Requirement ${id} has no test case`, id);
    const types = new Set(content.testCases.map((t) => t.type));
    for (const t of REQUIRED_TEST_TYPES) if (!types.has(t)) add('medium', 'Coverage', `No ${t} test cases`);
    const testedTasks = new Set(content.testCases.flatMap((t) => t.taskRefs));
    const untested = (ctx.tasks?.tasks || []).filter((t) => !testedTasks.has(t.id));
    if (untested.length) add('low', 'Traceability', `${untested.length} development tasks are not linked to any test: ${untested.slice(0, 6).map((t) => t.id).join(', ')}${untested.length > 6 ? '...' : ''}`);
    for (const t of content.testCases) {
      if (!t.steps.length || !t.expected) add('medium', 'Quality', `${t.id} is missing steps or expected result`, t.id);
      if (!t.assignee) add('low', 'Assignment', `${t.id} is unassigned`, t.id);
    }
    for (const r of ctx.requirements?.functional || []) {
      const count = content.testCases.filter((t) => t.reqRefs.includes(r.id)).length;
      if (r.acceptanceCriteria.length && count < r.acceptanceCriteria.length) add('medium', 'Coverage', `${r.id} has ${r.acceptanceCriteria.length} acceptance criteria but only ${count} tests`, r.id);
    }
  }
  return issues;
}

function score(issues) {
  const w = { high: 12, medium: 5, low: 1 };
  return Math.max(0, 100 - issues.reduce((s, i) => s + (w[i.severity] || 0), 0));
}

export async function review(stage, content, ctx) {
  const issues = deterministicReview(stage, content, ctx).map((i) => ({ ...i, source: 'rules' }));
  let summary = '';
  if (aiEnabled()) {
    try {
      const out = await chatJSON({
        system: 'You are a critical reviewer of software delivery artefacts. Find gaps, inconsistencies, risks and misalignment with requirements. Be specific and concise; at most 8 issues.',
        user: `Stage: ${stage}\nReturn {"summary": string, "issues": [{"severity":"high|medium|low","category":string,"message":string,"ref":string|null}]}\n<input name="requirements">${JSON.stringify(ctx.requirements || content).slice(0, 30000)}</input>\n<input name="artefact">${JSON.stringify(content).slice(0, 60000)}</input>`,
        maxTokens: 4000,
      });
      summary = String(out.summary || '');
      for (const i of (out.issues || []).slice(0, 8)) issues.push({ severity: ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'low', category: i.category || 'Review', message: String(i.message || ''), ref: i.ref || null, source: 'ai' });
    } catch (e) {
      summary = `AI critic unavailable (${e.message}); rule-based review only.`;
    }
  }
  const s = score(issues);
  return {
    score: s,
    verdict: s >= 85 ? 'Ready for review' : s >= 60 ? 'Review with caution' : 'Needs rework',
    summary: summary || `${issues.length} issue(s) found by rule-based checks.`,
    issues,
  };
}
