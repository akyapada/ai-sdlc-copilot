// Skill/capacity based assignment of tasks to developers and test cases to QA.
// Deterministic so that it is explainable and repeatable; humans can override in the UI.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9#+.]/g, '');

export const SKILL_CATEGORIES = {
  Backend: ['c#', '.net', 'aspnet', 'asp.netcore', 'java', 'spring', 'node', 'node.js', 'python', 'go', 'efcore', 'sql'],
  Frontend: ['angular', 'react', 'vue', 'typescript', 'javascript', 'css', 'html'],
  DevOps: ['devops', 'azure', 'aws', 'gcp', 'docker', 'kubernetes', 'terraform', 'cicd'],
  Security: ['security', 'azure', 'securitytesting', 'owasp'],
  Database: ['sql', 'efcore', 'database', 'cosmos', 'postgres', 'postgresql'],
  Integration: ['c#', 'aspnetcore', 'asp.netcore', 'java', 'node', 'apitesting', 'azure'],
  Performance: ['devops', 'azure', 'c#', 'sql'],
};

export function isDeveloper(m) { return /developer|devops|lead|engineer/i.test(m.role); }
export function isQA(m) { return /qa|test/i.test(m.role); }

/** Skills from the team sheet relevant to a task category (falls back to the category name). */
export function skillsFor(category, team) {
  const wanted = new Set(SKILL_CATEGORIES[category] || []);
  const skills = new Set();
  for (const m of team) for (const s of m.skills) if (wanted.has(norm(s))) skills.add(s);
  return skills.size ? [...skills] : [category];
}

function overlap(a, b) {
  const set = new Set(b.map(norm));
  return a.filter((x) => set.has(norm(x))).length;
}

export function assignTasks(tasks, team, { onlyUnassigned = false } = {}) {
  const allDevs = team.filter(isDeveloper);
  const devs = allDevs.filter((d) => d.capacity > 0); // zero capacity = unavailable, never assigned
  const load = Object.fromEntries(devs.map((d) => [d.name, 0]));
  if (onlyUnassigned) for (const t of tasks) if (t.assignee && load[t.assignee] != null) load[t.assignee] += Number(t.estimateHours) || 0;
  for (const t of tasks) {
    if (onlyUnassigned && t.assignee) continue;
    if (!devs.length) { t.assignee = ''; continue; }
    const hours = Number(t.estimateHours) || 8;
    let best = null;
    for (const d of devs) {
      const cap = d.capacity;
      const fit = (t.skills || []).length ? overlap(t.skills, d.skills) / t.skills.length : 0;
      // Skill fit dominates, but load (in weeks of work) increasingly spreads tasks across the team.
      const score = fit * 10 + (1 - load[d.name] / cap) * 8 - (fit === 0 ? 14 : 0);
      if (!best || score > best.score) best = { d, score };
    }
    t.assignee = best.d.name;
    t.skillGap = overlap(t.skills || [], best.d.skills) === 0 && (t.skills || []).length > 0;
    t.assignmentReason = `Skill match ${overlap(t.skills || [], best.d.skills)}/${(t.skills || []).length}; load before ${load[best.d.name]}h (capacity ${best.d.capacity}h/week)`;
    load[best.d.name] += hours;
  }
  return capacitySummary(tasks, allDevs, 'estimateHours');
}

export function capacitySummary(items, members, hoursField) {
  return members.map((m) => {
    const assigned = items.filter((t) => t.assignee === m.name).reduce((s, t) => s + (Number(t[hoursField]) || 0), 0);
    return { name: m.name, role: m.role, capacity: m.capacity, assignedHours: assigned, weeksOfWork: m.capacity ? Math.round((assigned / m.capacity) * 10) / 10 : null };
  });
}

const QA_PREFERENCE = {
  Security: ['securitytesting', 'security'],
  Integration: ['apitesting'],
  Performance: ['apitesting'],
  Usability: ['selenium'],
  Regression: ['selenium'],
};

export function assignTests(tests, team, { onlyUnassigned = false } = {}) {
  const allQas = team.filter(isQA);
  const qas = allQas.filter((q) => q.capacity > 0);
  const load = Object.fromEntries(qas.map((q) => [q.name, 0]));
  if (onlyUnassigned) for (const t of tests) if (t.assignee && load[t.assignee] != null) load[t.assignee] += Number(t.estimateHours) || 1;
  for (const t of tests) {
    t.estimateHours = Number(t.estimateHours) || (t.type === 'Performance' ? 4 : t.type === 'Security' ? 2 : 1);
    if (onlyUnassigned && t.assignee) continue;
    if (!qas.length) { t.assignee = ''; continue; }
    const pref = QA_PREFERENCE[t.type] || [];
    let best = null;
    for (const q of qas) {
      const skillHit = q.skills.some((s) => pref.includes(norm(s))) ? 6 : 0;
      const score = skillHit - (load[q.name] / q.capacity) * 10;
      if (!best || score > best.score) best = { q, score };
    }
    t.assignee = best.q.name;
    load[best.q.name] += t.estimateHours;
  }
  return capacitySummary(tests, allQas, 'estimateHours');
}

/** Topological order of tasks by dependsOn. Returns { order, cycles }. */
export function sequenceTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Map();
  const order = [];
  const cycles = [];
  const visit = (t, stack) => {
    if (visited.get(t.id) === 2) return;
    if (visited.get(t.id) === 1) { cycles.push([...stack, t.id].join(' -> ')); return; }
    visited.set(t.id, 1);
    for (const dep of t.dependsOn || []) if (byId.has(dep)) visit(byId.get(dep), [...stack, t.id]);
    visited.set(t.id, 2);
    order.push(t.id);
  };
  for (const t of tasks) visit(t, []);
  order.forEach((id, i) => { byId.get(id).sequence = i + 1; });
  return { order, cycles };
}
