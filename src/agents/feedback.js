// Review-feedback agent: regenerates an artefact version by applying reviewer suggestions
// (and optionally the critic's findings), returning the revised content plus a change log.

import { aiEnabled } from '../config.js';
import { chatJSON } from '../llm.js';
import { STAGE_SCHEMAS, normalize } from './specialists.js';
import { skillsFor } from './assign.js';

const LISTS = {
  requirements: ['functional', 'nonFunctional', 'constraints', 'conflicts', 'ambiguities', 'dependencies', 'gaps', 'assumptions', 'risks'],
  architecture: ['components', 'integrationPoints', 'dataFlows', 'security'],
  tasks: ['tasks'],
  tests: ['testCases'],
};

export async function reviseWithFeedback(stage, content, { feedback, criticIssues = [], addressCritic = false, ctx }) {
  const issues = addressCritic ? criticIssues : [];
  if (aiEnabled()) {
    try {
      const out = await chatJSON({
        system: `You are a revision agent. Apply the reviewer's feedback to the ${stage} artefact precisely. Keep unchanged items and their IDs stable; add new items with new IDs. Keep reqRefs accurate. Return {"content": <artefact>, "changeLog": [{"change": string, "reason": string}]}.`,
        user: `Artefact schema:\n${STAGE_SCHEMAS[stage]}\n\n<input name="current-artefact">${JSON.stringify(content)}</input>\n\n<feedback>${feedback || '(none)'}</feedback>\n\n${issues.length ? `<input name="critic-findings">${JSON.stringify(issues)}</input>\nAlso resolve these critic findings where possible.` : ''}\n${ctx.requirements && stage !== 'requirements' ? `<input name="approved-requirements">${JSON.stringify(ctx.requirements).slice(0, 40000)}</input>` : ''}`,
      });
      return { content: normalize(stage, out.content || out, ctx), changeLog: Array.isArray(out.changeLog) ? out.changeLog : [] };
    } catch (e) {
      const r = ruleBasedRevision(stage, content, feedback, issues, ctx);
      r.changeLog.unshift({ change: 'AI revision unavailable - applied rule-based revision', reason: e.message });
      return r;
    }
  }
  return ruleBasedRevision(stage, content, feedback, issues, ctx);
}

const ID = '([A-Z]{1,4}-\\d{1,4})';

function findItem(stage, c, id) {
  for (const key of LISTS[stage]) {
    const idx = (c[key] || []).findIndex((x) => x.id?.toUpperCase() === id.toUpperCase());
    if (idx >= 0) return { key, idx, item: c[key][idx] };
  }
  return null;
}

function nextId(list, prefix, width) {
  const max = list.reduce((m, x) => Math.max(m, Number(String(x.id).match(/(\d+)$/)?.[1] || 0)), 0);
  return `${prefix}-${String(max + 1).padStart(width, '0')}`;
}

/** Offline revision: understands common reviewer commands; anything else is recorded as a directive. */
function ruleBasedRevision(stage, content, feedback, criticIssues, ctx) {
  const c = structuredClone(content);
  const log = [];
  const team = ctx.team || [];
  const lines = String(feedback || '').split(/\n|;/).map((l) => l.trim()).filter(Boolean);
  const mentionedReqs = (s) => [...new Set((s.match(/\b(?:FR|NFR|BR|REQ)-\d+\b/gi) || []).map((x) => x.toUpperCase()))];

  const rejected = (line, why) => log.push({ change: 'Not applied', reason: `${line} - ${why}` });
  // Resolve a person: exact name, then a unique first/last name, then a unique substring (3+ chars).
  const resolvePerson = (raw, roleRe) => {
    const q = raw.trim().replace(/[.!]+$/, '').toLowerCase();
    const pool = team.filter((t) => roleRe.test(t.role));
    const exact = pool.filter((t) => t.name.toLowerCase() === q);
    if (exact.length) return { who: exact[0] };
    const token = pool.filter((t) => t.name.toLowerCase().split(/\s+/).includes(q));
    if (token.length === 1) return { who: token[0] };
    const sub = q.length >= 3 ? pool.filter((t) => t.name.toLowerCase().includes(q)) : [];
    const hits = token.length > 1 ? token : sub;
    if (hits.length === 1) return { who: hits[0] };
    if (hits.length > 1) return { error: `"${raw.trim()}" is ambiguous (${hits.map((t) => t.name).join(', ')})` };
    const other = team.find((t) => t.name.toLowerCase() === q || t.name.toLowerCase().split(/\s+/).includes(q));
    return { error: other ? `${other.name} is a ${other.role}, not eligible for this stage` : `no team member matches "${raw.trim()}"` };
  };
  const PRIORITIES = { requirements: ['Must', 'Should', 'Could'], architecture: [], tasks: ['P1', 'P2', 'P3'], tests: ['High', 'Medium', 'Low'] };
  // Replace text in string VALUES only, so keys, IDs and JSON structure can never be corrupted.
  const replaceInValues = (node, re, to) => {
    let n = 0;
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'id' ? x : walk(x)]));
      if (typeof v === 'string' && re.test(v)) { re.lastIndex = 0; n++; return v.replace(re, () => to); }
      return v;
    };
    return { value: walk(node), count: n };
  };

  for (const line of lines) {
    let m;
    if (line.length > 1000) { rejected(line.slice(0, 60), 'instruction longer than 1000 characters'); continue; }
    if ((m = line.match(new RegExp(`^(?:remove|delete|drop)\\s+${ID}\\b`, 'i')))) {
      const f = findItem(stage, c, m[1]);
      if (f) { c[f.key].splice(f.idx, 1); log.push({ change: `Removed ${m[1].toUpperCase()}`, reason: line }); } else rejected(line, `unknown ID ${m[1].toUpperCase()}`);
      continue;
    }
    if ((m = line.match(new RegExp(`^(?:re)?assign\\s+${ID}\\s+to\\s+(.+)$`, 'i')))) {
      const f = findItem(stage, c, m[1]);
      if (!f) { rejected(line, `unknown ID ${m[1].toUpperCase()}`); continue; }
      if (!('assignee' in f.item)) { rejected(line, `${f.item.id} cannot be assigned`); continue; }
      const { who, error } = resolvePerson(m[2], stage === 'tests' ? /qa|test/i : /developer|devops|lead|engineer/i);
      if (error) { rejected(line, error); continue; }
      if (!(who.capacity > 0)) { rejected(line, `${who.name} has 0 capacity`); continue; }
      f.item.assignee = who.name; f.item.assignmentReason = 'Set by reviewer';
      log.push({ change: `Assigned ${f.item.id} to ${who.name}`, reason: line });
      continue;
    }
    if ((m = line.match(new RegExp(`^(?:set\\s+)?priority\\s+(?:of\\s+)?${ID}\\s+(?:to\\s+)?(\\w+)`, 'i')))) {
      const f = findItem(stage, c, m[1]);
      const allowed = PRIORITIES[stage];
      const value = allowed.find((p) => p.toLowerCase() === m[2].toLowerCase());
      if (!f) rejected(line, `unknown ID ${m[1].toUpperCase()}`);
      else if (!value) rejected(line, `priority must be one of ${allowed.join(', ') || '(none for this stage)'}`);
      else { f.item.priority = value; log.push({ change: `Priority of ${f.item.id} -> ${value}`, reason: line }); }
      continue;
    }
    if ((m = line.match(new RegExp(`^(?:set\\s+)?(?:estimate|effort|hours)\\s+(?:of\\s+)?${ID}\\s+(?:to\\s+)?(-?\\d+(?:\\.\\d+)?)`, 'i')))) {
      const f = findItem(stage, c, m[1]);
      const hours = Number(m[2]);
      if (!f) rejected(line, `unknown ID ${m[1].toUpperCase()}`);
      else if (!(hours > 0 && hours <= 400)) rejected(line, 'estimate must be between 1 and 400 hours');
      else { f.item.estimateHours = hours; log.push({ change: `Estimate of ${f.item.id} -> ${hours}h`, reason: line }); }
      continue;
    }
    if ((m = line.match(new RegExp(`^rename\\s+${ID}\\s+to\\s+(.+)$`, 'i')))) {
      const f = findItem(stage, c, m[1]);
      if (f) { f.item[f.item.name != null ? 'name' : 'title'] = m[2].slice(0, 200); log.push({ change: `Renamed ${f.item.id}`, reason: line }); } else rejected(line, `unknown ID ${m[1].toUpperCase()}`);
      continue;
    }
    if ((m = line.match(/^use\s+(.+?)\s+(?:instead of|rather than)\s+(.+?)\.?$/i))) {
      const [, to, from] = m;
      if (from.trim().length < 3) { rejected(line, 'text to replace is too short'); continue; }
      const { value, count } = replaceInValues(c, new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to);
      if (count) { Object.assign(c, value); log.push({ change: `Replaced "${from}" with "${to}" in ${count} place(s)`, reason: line }); } else rejected(line, `"${from}" not found`);
      continue;
    }
    if ((m = line.match(/^add\s+(?:an?\s+)?(task|test(?:\s*case)?|component|risk|assumption|question|gap|security control)\s*(?:for|to|:|-)?\s*(.+)$/i))) {
      const kind = m[1].toLowerCase();
      const text = m[2].trim();
      const refs = mentionedReqs(text);
      if (stage === 'tasks' && kind === 'task') {
        const id = nextId(c.tasks, 'T', 3);
        c.tasks.push({ id, title: text, description: `Added by reviewer: ${text}`, type: /ui|screen|page/i.test(text) ? 'Frontend' : /test|load|perf/i.test(text) ? 'Performance' : /secur/i.test(text) ? 'Security' : 'Backend', componentRef: '', reqRefs: refs, dependsOn: [], skills: skillsFor('Backend', team), complexity: 'M', estimateHours: 8, priority: 'P2', acceptanceCriteria: [], assignee: '', status: 'To Do' });
        log.push({ change: `Added task ${id}`, reason: line }); continue;
      }
      if (stage === 'tests' && kind.startsWith('test')) {
        const id = nextId(c.testCases, 'TC', 3);
        const type = ['Negative', 'Boundary', 'Integration', 'Regression', 'Security', 'Usability', 'Performance'].find((t) => new RegExp(t, 'i').test(text)) || 'Positive';
        c.testCases.push({ id, title: text, type, reqRefs: refs, taskRefs: [], preconditions: '', steps: ['Steps to be detailed by QA.'], expected: 'Expected result to be confirmed by QA.', priority: 'Medium', assignee: '', status: 'Draft' });
        log.push({ change: `Added test ${id}`, reason: line }); continue;
      }
      if (stage === 'architecture' && kind === 'component') {
        const id = nextId(c.components, 'C', 2);
        c.components.push({ id, name: text.split(/[.,(]/)[0].slice(0, 60), responsibility: text, technology: 'TBD', category: 'Backend', reqRefs: refs });
        log.push({ change: `Added component ${id}`, reason: line }); continue;
      }
      if (stage === 'architecture' && kind === 'security control') {
        const id = nextId(c.security, 'S', 2);
        c.security.push({ id, concern: text, control: text, reqRefs: refs });
        log.push({ change: `Added security control ${id}`, reason: line }); continue;
      }
      if (stage === 'architecture' && (kind === 'question' || kind === 'assumption')) {
        c[kind === 'question' ? 'openQuestions' : 'assumptions'].push(text);
        log.push({ change: `Added ${kind}`, reason: line }); continue;
      }
      if (stage === 'requirements' && ['risk', 'assumption', 'gap', 'question'].includes(kind)) {
        const key = { risk: 'risks', assumption: 'assumptions', gap: 'gaps', question: 'ambiguities' }[kind];
        const prefix = { risks: 'R', assumptions: 'AS', gaps: 'G', ambiguities: 'A' }[key];
        const id = nextId(c[key], prefix, 2);
        c[key].push(kind === 'risk' ? { id, ref: refs[0] || 'GENERAL', text, severity: 'Medium', mitigation: 'TBD' } : kind === 'gap' ? { id, ref: refs[0] || 'GENERAL', text, recommendation: 'TBD', severity: 'Medium' } : kind === 'question' ? { id, ref: refs[0] || 'GENERAL', text, question: text } : { id, text });
        log.push({ change: `Added ${kind} ${id}`, reason: line }); continue;
      }
    }
    if ((m = line.match(new RegExp(`^(?:resolve|close|clarify)\\s+${ID}\\s*[:-]?\\s*(.*)$`, 'i'))) && stage === 'requirements') {
      const f = findItem(stage, c, m[1]);
      if (f && (f.key === 'ambiguities' || f.key === 'conflicts')) {
        c[f.key].splice(f.idx, 1);
        c.assumptions.push({ id: nextId(c.assumptions, 'AS', 2), text: `Clarified (${m[1]}): ${m[2] || 'resolved by reviewer'}` });
        log.push({ change: `Resolved ${f.key === 'conflicts' ? 'conflict' : 'ambiguity'} ${m[1]}`, reason: line }); continue;
      }
      rejected(line, f ? `${m[1].toUpperCase()} is not an ambiguity or conflict` : `unknown ID ${m[1].toUpperCase()}`);
      continue;
    }
    c.reviewerNotes = [...(c.reviewerNotes || []), line];
    log.push({ change: 'Recorded reviewer directive', reason: `${line} (free-text regeneration requires Azure OpenAI; recorded for the next reviewer)` });
  }

  // Auto-fix coverage findings from the critic.
  for (const issue of criticIssues) {
    const id = issue.ref;
    if (!id || !/Traceability/.test(issue.category)) continue;
    const req = [...(ctx.requirements?.functional || []), ...(ctx.requirements?.nonFunctional || [])].find((r) => r.id === id);
    if (!req) continue;
    if (stage === 'tasks' && /no development task/.test(issue.message)) {
      const tid = nextId(c.tasks, 'T', 3);
      c.tasks.push({ id: tid, title: `${req.id}: Implement ${req.title}`, description: req.description, type: req.id.startsWith('NFR') ? 'Security' : 'Backend', componentRef: '', reqRefs: [req.id], dependsOn: [], skills: skillsFor('Backend', team), complexity: 'L', estimateHours: 16, priority: 'P1', acceptanceCriteria: req.acceptanceCriteria || [], assignee: '', status: 'To Do' });
      log.push({ change: `Added task ${tid} for uncovered ${req.id}`, reason: issue.message });
    } else if (stage === 'tests' && /no test case/.test(issue.message)) {
      const tid = nextId(c.testCases, 'TC', 3);
      c.testCases.push({ id: tid, title: `${req.id}: verify ${req.title}`, type: 'Positive', reqRefs: [req.id], taskRefs: [], preconditions: '', steps: ['Execute the scenario described in the requirement.'], expected: req.description || req.title, priority: 'High', assignee: '', status: 'Draft' });
      log.push({ change: `Added test ${tid} for uncovered ${req.id}`, reason: issue.message });
    } else if (stage === 'architecture' && /not addressed by any component/.test(issue.message)) {
      const core = c.components.find((x) => x.category === 'Backend') || c.components[0];
      if (core) { core.reqRefs = [...new Set([...core.reqRefs, req.id])]; log.push({ change: `Mapped ${req.id} to ${core.id}`, reason: issue.message }); }
    }
  }
  return { content: normalize(stage, c, ctx), changeLog: log };
}

/** Structured diff of two artefact versions, by item ID per list. */
export function diffContent(stage, before, after) {
  const out = { added: [], removed: [], modified: [] };
  if (!before) return out;
  for (const key of LISTS[stage]) {
    const a = new Map((before[key] || []).map((x) => [x.id, x]));
    const b = new Map((after[key] || []).map((x) => [x.id, x]));
    for (const [id, item] of b) {
      if (!a.has(id)) out.added.push({ list: key, id, label: item.title || item.name || item.text || item.concern || '' });
      else {
        const fields = Object.keys({ ...a.get(id), ...item }).filter((f) => f !== 'assignmentReason' && JSON.stringify(a.get(id)[f]) !== JSON.stringify(item[f]));
        if (fields.length) out.modified.push({ list: key, id, fields });
      }
    }
    for (const [id, item] of a) if (!b.has(id)) out.removed.push({ list: key, id, label: item.title || item.name || item.text || '' });
  }
  for (const key of ['overview', 'summary', 'sequencingNotes']) {
    if (before[key] !== undefined && before[key] !== after[key]) out.modified.push({ list: key, id: key, fields: [key] });
  }
  return out;
}
