// Offline engine: deterministic, rule-based versions of the specialist agents.
// Used when Azure OpenAI is not configured (or fails) so the full workflow can always be demonstrated.

import { skillsFor } from './assign.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const uniq = (a) => [...new Set(a.filter(Boolean))];
const REQ_RE = /^((?:FR|NFR|BR|REQ|UR|SR)[-_]?\d{1,5})\s*[:\-–]?\s*(.*)$/i;
const LABEL_RE = /^([A-Z][A-Za-z &/()-]{2,40}):\s*(.*)$/;

// ======================= Requirements analysis =======================
export function analyzeRequirements(doc) {
  const reqs = [];
  const global = [];
  const intro = [];
  const duplicates = [];
  const unidentified = [];
  const seenIds = new Set();
  let cur = null;
  let label = 'description';
  for (const p of doc.paragraphs) {
    const m = p.match(REQ_RE);
    if (m) {
      let id = m[1].toUpperCase().replace('_', '-');
      if (seenIds.has(id)) {
        // Never silently merge or renumber: keep both, mark the clash for the reviewer.
        const newId = `${id}-B${duplicates.filter((d) => d.id === id).length || ''}`;
        duplicates.push({ id, newId, title: m[2].trim() });
        id = newId;
      }
      seenIds.add(id);
      cur = { id, title: m[2].trim(), buckets: { description: [] } };
      reqs.push(cur);
      label = 'description';
      continue;
    }
    if (/^\d+\.\s+\S/.test(p)) { cur = null; continue; }
    // A "The system shall..." statement after a requirement's description is a new, un-numbered requirement.
    if (/^(?:the\s+)?(?:system|platform|application|service|solution)\s+(?:shall|must|should|will)\b/i.test(p)
        && (!cur || (label === 'description' && cur.buckets.description.length))) {
      const id = `FR-U${pad(unidentified.length + 1)}`;
      unidentified.push({ id, text: p });
      cur = { id, title: p.replace(/^(?:the\s+)?\w+\s+(?:shall|must|should|will)\s+/i, '').slice(0, 70), buckets: { description: [p] } };
      reqs.push(cur);
      continue;
    }
    if (!cur) {
      if (/out of scope|constraint/i.test(p)) global.push(p);
      else if (!/^(project|version|author)\s*:/i.test(p)) intro.push(p);
      continue;
    }
    const lm = p.match(LABEL_RE);
    if (lm && lm[1].split(' ').length <= 4) {
      label = lm[1].toLowerCase();
      cur.buckets[label] = cur.buckets[label] || [];
      if (lm[2]) cur.buckets[label].push(lm[2]);
    } else {
      (cur.buckets[label] = cur.buckets[label] || []).push(p);
    }
  }

  // Fallback when the document has no requirement IDs: every "must/shall" sentence becomes a requirement.
  if (!reqs.length) {
    doc.text.split(/(?<=[.!?])\s+/).filter((s) => /\b(must|shall|should)\b/i.test(s)).slice(0, 30).forEach((s, i) => {
      const nfr = /\b(performance|latency|secure|security|encrypt|available|availability|scal|response time|compliance)\b/i.test(s);
      reqs.push({ id: `${nfr ? 'NFR' : 'FR'}-${pad(i + 1, 3)}`, title: s.slice(0, 70), buckets: { description: [s] } });
    });
  }

  const functional = [];
  const nonFunctional = [];
  for (const r of reqs) {
    const b = r.buckets;
    const description = (b.description || []).join(' ');
    const acceptanceCriteria = b['acceptance criteria'] || [];
    const details = Object.entries(b).filter(([k]) => k !== 'description' && k !== 'acceptance criteria').flatMap(([, v]) => v);
    const all = [description, ...details, ...acceptanceCriteria].join(' ');
    if (r.id.startsWith('NFR')) {
      nonFunctional.push({
        id: r.id,
        category: categorize(`${r.title} ${all}`),
        title: r.title,
        description: [description, ...details].filter(Boolean).join(' '),
        metric: extractMetric(all),
        priority: 'Must',
      });
    } else {
      functional.push({
        id: r.id,
        title: r.title,
        description,
        details,
        acceptanceCriteria,
        priority: /\bmust\b/i.test(all) ? 'Must' : 'Should',
      });
    }
  }

  const allReqText = (r) => [r.description, ...(r.details || []), ...(r.acceptanceCriteria || [])].join(' ');
  const ambiguities = [];
  const ambSeen = new Set();
  const addAmb = (ref, text, question) => {
    if (ambSeen.has(`${ref}|${question}`)) return;
    ambSeen.add(`${ref}|${question}`);
    ambiguities.push({ id: `A-${pad(ambiguities.length + 1)}`, ref, text, question });
  };
  const VAGUE = {
    'high-speed': 'What is the measurable target for "high-speed"?',
    securely: 'Which security standard / mechanism is meant by "securely"?',
    secure: 'Which security standard / controls define "secure"?',
    brief: 'What exact duration is "brief"?',
    immediately: 'What is the maximum acceptable latency for "immediately"?',
    accurately: 'What tolerance defines "accurately"?',
    flags: 'What happens after an account is flagged, and who reviews it?',
    'user-friendly': 'What usability criteria define "user-friendly"?',
    fast: 'What is the measurable target for "fast"?',
    appropriate: 'Who decides what is "appropriate" and by what rule?',
    quickly: 'What is the measurable target for "quickly"?',
    'highly available': 'What availability SLO (e.g. 99.9%) and RTO/RPO are required?',
    'as needed': 'What load / growth figures define "as needed"?',
    'as appropriate': 'Who decides what is "appropriate" and by what rule?',
    robust: 'What failure scenarios must "robust" survive?',
  };
  for (const d of duplicates) addAmb(d.newId, `Duplicate requirement ID ${d.id}`, `"${d.title}" reuses ${d.id}; it was kept as ${d.newId}. Which ID is correct?`);
  for (const u of unidentified) addAmb(u.id, 'Requirement without an ID', `"${u.text.slice(0, 80)}" has no requirement ID; it was captured as ${u.id}. Confirm its ID and acceptance criteria.`);
  for (const p of intro) {
    for (const [term, q] of Object.entries(VAGUE)) {
      if (new RegExp(`\\b${term}\\b`, 'i').test(p)) addAmb('GENERAL', `Vague term "${term}" in objectives`, q);
    }
  }
  for (const r of [...functional, ...nonFunctional]) {
    const t = allReqText(r);
    for (const [term, q] of Object.entries(VAGUE)) {
      if (new RegExp(`\\b${term}\\b`, 'i').test(t)) addAmb(r.id, `Vague term "${term}"`, q);
    }
    for (const b of boundaries(t)) addAmb(r.id, `Boundary "${b.phrase}"`, `Is the value ${b.value} inclusive or exclusive? Define behaviour exactly at ${b.value}.`);
  }
  for (const g of global) for (const b of boundaries(g)) addAmb('CONSTRAINT', `Boundary "${b.phrase}"`, `Is exactly ${b.value} included? Define behaviour at the limit.`);
  if (/\b(\d{4,}|\d+,\d{3})\b/.test(doc.text) && !/currency|usd|eur|inr/i.test(doc.text)) addAmb('GENERAL', 'Currency not specified', 'Which currency applies to monetary values?');

  const dependencies = [];
  const seenDep = new Set();
  for (const r of [...functional, ...nonFunctional]) {
    for (const name of externalSystems(allReqText(r))) {
      const key = name.toLowerCase();
      if (seenDep.has(key)) { dependencies.find((d) => d.name.toLowerCase() === key).refs.push(r.id); continue; }
      seenDep.add(key);
      dependencies.push({ id: `D-${pad(dependencies.length + 1)}`, ref: r.id, refs: [r.id], name, type: 'External', text: `${r.id} depends on ${name}` });
    }
    for (const other of [...functional, ...nonFunctional]) {
      if (other.id !== r.id && allReqText(r).includes(other.id)) {
        dependencies.push({ id: `D-${pad(dependencies.length + 1)}`, ref: r.id, refs: [r.id], name: other.id, type: 'Internal', text: `${r.id} depends on ${other.id}` });
      }
    }
  }
  // Integrations listed outside any requirement (e.g. an "Integrations:" section) are still dependencies.
  for (const p of [...intro, ...global]) {
    for (const name of externalSystems(p)) {
      if (seenDep.has(name.toLowerCase())) continue;
      seenDep.add(name.toLowerCase());
      dependencies.push({ id: `D-${pad(dependencies.length + 1)}`, ref: 'GENERAL', refs: [], name, type: 'External', text: `Listed integration: ${name} (no requirement describes how it is used)` });
    }
  }
  for (const d of dependencies) d.refs = uniq(d.refs);

  const text = doc.text;
  const gaps = [];
  const addGap = (ref, t, recommendation, severity = 'Medium') => gaps.push({ id: `G-${pad(gaps.length + 1)}`, ref, text: t, recommendation, severity });
  const knownIds = new Set([...functional, ...nonFunctional].map((r) => r.id));
  for (const r of [...functional, ...nonFunctional]) {
    for (const ref of allReqText(r).match(/\b(?:FR|NFR|BR|REQ)-\d+\b/g) || []) {
      if (!knownIds.has(ref)) addGap(r.id, `${r.id} references ${ref}, which does not exist in the document`, `Add ${ref} or correct the reference in ${r.id}.`, 'High');
    }
  }
  for (const d of dependencies.filter((x) => x.ref === 'GENERAL')) addGap('GENERAL', `${d.name} is listed as an integration but no requirement defines its behaviour`, `Add a requirement describing data exchanged with ${d.name}, error handling and SLAs.`);

  // Conflicts: statements that cannot all be true; these block approval until resolved.
  const conflicts = [];
  const addConflict = (refs, t, question) => conflicts.push({ id: `X-${pad(conflicts.length + 1)}`, refs: uniq(refs), text: t, question });
  const SIG = (s) => new Set(String(s).toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !['scope', 'phase', 'explicitly', 'during', 'system', 'patients', 'users', 'should', 'which', 'their', 'there'].includes(w)) || []);
  for (const g of global.filter((x) => /out of scope/i.test(x))) {
    const words = SIG(g.replace(/out of scope/i, ''));
    for (const r of functional) {
      const hit = [...SIG(r.title)].filter((w) => words.has(w) || words.has(`${w}s`) || words.has(w.replace(/s$/, '')));
      if (hit.length) addConflict([r.id], `${r.id} "${r.title}" is in scope, but the document also says: "${g}"`, `Is ${r.title} in or out of scope for this phase?`);
    }
  }
  const security = nonFunctional.filter((n) => /pci|hipaa|gdpr|encrypt|secur|privacy/i.test(`${n.title} ${n.description}`));
  for (const r of [...functional, ...nonFunctional]) {
    const t = allReqText(r);
    if (/\b(store|save|persist|log)\w*\b[^.]{0,60}\b(cvv|cvc|full card number|card number|password)\b/i.test(t)) {
      addConflict([r.id, ...security.map((s) => s.id)], `${r.id} requires storing sensitive credentials, which violates PCI-DSS${security.length ? ` and conflicts with ${security.map((s) => s.id).join(', ')}` : ''}`, 'Replace raw card/CVV storage with gateway tokens; confirm the refund design.');
    }
    const lat = [...t.matchAll(/(?:less than|under|below|within)\s+(\d[\d,.]*)\s*(milliseconds|ms|seconds?|s)\b/gi)].map((x) => `${x[1]} ${x[2]}`);
    if (uniq(lat).length > 1) addConflict([r.id], `${r.id} states different targets: ${uniq(lat).join(' vs ')}`, 'Which target applies to which operation?');
  }
  for (const d of dependencies.filter((x) => x.type === 'External')) {
    if (!/timeout|unavailable|retry|fallback|circuit/i.test(text)) {
      addGap(d.ref, `No behaviour defined when ${d.name} is slow, times out or is unavailable`, `Define timeout, retry policy and fail-open/fail-closed behaviour for ${d.name}.`, 'High');
    }
  }
  const findRef = (re) => [...functional, ...nonFunctional].find((r) => re.test(allReqText(r)))?.id || 'GENERAL';
  if (/\botp\b|one-time password/i.test(text) && !/expir|attempt|resend/i.test(text)) addGap(findRef(/otp|one-time/i), 'OTP expiry, retry limits and resend rules are not defined', 'Specify OTP validity window, max attempts and lockout behaviour.', 'High');
  if (/\bflag/i.test(text) && !/unflag|appeal|manual review/i.test(text)) addGap(findRef(/flag/i), 'Process for reviewing / clearing flagged accounts is undefined', 'Define the fraud-ops review workflow and SLA for flagged accounts.');
  if (/cancel/i.test(text) && !/cancel(?:led|ation)? (?:after|once)/i.test(text)) addGap(findRef(/cancel/i), 'Behaviour when cancel is pressed at the exact moment the timer expires is undefined', 'Define race-condition handling between cancel and auto-submit.');
  if (!/audit|logging|log /i.test(text)) addGap('GENERAL', 'No audit logging / traceability requirement', 'Add requirement for audit trail of orders, fraud decisions and step-up auth.');
  if (!/availability|uptime|sla/i.test(text)) addGap('GENERAL', 'No availability / uptime target', 'Define availability SLO (e.g. 99.9%) and RTO/RPO.');
  if (!/accessib|wcag/i.test(text)) addGap('GENERAL', 'No accessibility requirement', 'Add WCAG 2.1 AA compliance for customer-facing UI.', 'Low');
  if (!/retention|gdpr|privacy|delete/i.test(text)) addGap('GENERAL', 'No data retention / privacy requirement', 'Define retention period for transaction metadata (IP, device ID, location).');
  if (/payment|transaction|order/i.test(text) && !/declin|failed payment|payment fail/i.test(text)) addGap(findRef(/payment|order/i), 'Payment decline / failure handling is not specified', 'Define user messaging and retry behaviour when the gateway declines.');
  if (!/monitor|alert|observab/i.test(text)) addGap('GENERAL', 'No monitoring / alerting requirement', 'Add observability requirements (metrics, tracing, alerts on fraud-API latency).', 'Low');

  const risks = [];
  const addRisk = (ref, t, severity, mitigation) => risks.push({ id: `R-${pad(risks.length + 1)}`, ref, text: t, severity, mitigation });
  for (const d of dependencies.filter((x) => x.type === 'External')) addRisk(d.ref, `Dependency on ${d.name} - outages or latency directly impact the flow`, 'High', 'Circuit breaker, timeouts, contract tests and a documented fallback.');
  for (const n of nonFunctional) {
    if (n.category === 'Performance') addRisk(n.id, `Performance target may not be met: ${n.metric || n.title}`, 'High', 'Early load testing, caching, async processing, performance budget in CI.');
    if (n.category === 'Security' || n.category === 'Compliance') addRisk(n.id, `Compliance risk: ${n.title}`, 'High', 'Tokenisation via gateway, PCI scope reduction, security review and pen test.');
  }
  if (ambiguities.length > 4) addRisk('GENERAL', `${ambiguities.length} ambiguities may cause rework`, 'Medium', 'Resolve open questions with product owner before sprint start.');

  const outOfScope = global.filter((g) => /out of scope/i.test(g)).map((g) => g.replace(/^out of scope\s*:\s*/i, ''));
  const constraints = global.filter((g) => /constraint/i.test(g)).map((g, i) => ({ id: `CON-${pad(i + 1)}`, text: g.replace(/^[^:]*constraint\s*:\s*/i, '') }));

  const assumptions = [];
  const addAs = (t) => assumptions.push({ id: `AS-${pad(assumptions.length + 1)}`, text: t });
  if (/authenticated/i.test(text)) addAs('Users are already authenticated before using the feature.');
  if (/token/i.test(text)) addAs('The payment gateway provides tokenisation and stores card data (PCI scope reduction).');
  if (/usd/i.test(text)) addAs('All amounts are in USD for this phase.');
  for (const d of dependencies.filter((x) => x.type === 'External')) addAs(`${d.name} provides a documented, versioned API with a sandbox environment.`);
  addAs('Existing standard checkout remains available as a fallback path.');

  return {
    summary: intro.join(' ').slice(0, 900) || doc.title,
    functional,
    nonFunctional,
    constraints,
    outOfScope,
    conflicts,
    ambiguities,
    dependencies,
    gaps,
    assumptions,
    risks,
  };
}

function categorize(t) {
  if (/pci|gdpr|hipaa|compliance/i.test(t)) return 'Compliance';
  if (/encrypt|security|secure|auth/i.test(t)) return 'Security';
  if (/latency|performance|response|throughput|requests per second|ms\b/i.test(t)) return 'Performance';
  if (/availab|uptime/i.test(t)) return 'Availability';
  if (/scal/i.test(t)) return 'Scalability';
  if (/usab|accessib/i.test(t)) return 'Usability';
  return 'Other';
}

function extractMetric(t) {
  const parts = [];
  const lat = t.match(/(?:less than|under|below|within)\s+(\d[\d,.]*)\s*(milliseconds|ms|seconds?|s)\b/i);
  if (lat) parts.push(`< ${lat[1]} ${lat[2]}`);
  const rps = t.match(/(\d[\d,.]*)\s*(requests per second|rps|tps|transactions per second)/i);
  if (rps) parts.push(`@ ${rps[1]} ${rps[2]}`);
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) parts.push(`${pct[1]}%`);
  return parts.join(' ') || '';
}

export function boundaries(t) {
  const out = [];
  const add = (phrase, value, kind) => out.push({ phrase, value: Number(String(value).replace(/,/g, '')), raw: value, kind });
  for (const m of t.matchAll(/\b(below|under|less than|fewer than|shorter than)\s+\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\b(?!\s*(?:ms|milliseconds|seconds?|minutes?|hours?|requests|concurrent))/gi)) add(m[0], m[2], 'below');
  for (const m of t.matchAll(/\b(above|over|exceeding|more than|greater than|longer than)\s+\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/gi)) add(m[0], m[2], 'above');
  for (const m of t.matchAll(/\bbetween\s+\$?(\d{1,3}(?:,\d{3})+|\d+)\s+and\s+\$?(\d{1,3}(?:,\d{3})+|\d+)/gi)) { add(m[0], m[1], 'between-low'); add(m[0], m[2], 'between-high'); }
  return out;
}

function externalSystems(t) {
  const names = [];
  for (const m of t.matchAll(/\b([A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)*)\s+(API|Service|Gateway)\b/g)) {
    if (!/^(The|This|Our|An?|Checkout|Express)$/.test(m[1])) names.push(`${m[1]} ${m[2]}`);
  }
  if (/payment gateway/i.test(t)) names.push('Payment Gateway');
  if (/\bsms\b/i.test(t)) names.push('SMS Provider');
  if (/\bemail\b/i.test(t)) names.push('Email Provider');
  const canonical = (n) => (/^sms\b/i.test(n) ? 'SMS Provider' : /^(payment|stripe)/i.test(n) ? 'Payment Gateway' : /^e-?mail\b/i.test(n) ? 'Email Provider' : n);
  return uniq(names.map(canonical));
}

// ======================= Architecture =======================
function techStack(team) {
  const skills = team.flatMap((m) => m.skills).map((s) => s.toLowerCase()).join(' ');
  return {
    backend: /c#|asp\.net|\.net/.test(skills) ? 'ASP.NET Core 8 Web API (C#)' : /java|spring/.test(skills) ? 'Spring Boot (Java)' : /node/.test(skills) ? 'Node.js (TypeScript)' : 'ASP.NET Core 8 Web API (C#)',
    frontend: /angular/.test(skills) ? 'Angular 18 + TypeScript' : /react/.test(skills) ? 'React + TypeScript' : 'Angular + TypeScript',
    data: /sql|ef core/.test(skills) ? 'Azure SQL Database (EF Core)' : 'Azure SQL Database',
    cloud: /azure/.test(skills) ? 'Azure' : /aws/.test(skills) ? 'AWS' : 'Azure',
    devops: /devops/.test(skills) ? 'Azure DevOps Pipelines + Bicep' : 'GitHub Actions',
    testing: /selenium/.test(skills) ? 'Selenium / Playwright UI tests, Postman + RestSharp API tests' : 'Playwright, xUnit',
  };
}

export function draftArchitecture(reqs, team, title) {
  const stack = techStack(team);
  const fr = reqs.functional || [];
  const nfr = reqs.nonFunctional || [];
  const allIds = [...fr, ...nfr].map((r) => r.id);
  const text = (r) => [r.title, r.description, ...(r.details || []), ...(r.acceptanceCriteria || [])].join(' ');
  const refsWhere = (re) => [...fr, ...nfr].filter((r) => re.test(text(r))).map((r) => r.id);
  const domain = (title || 'Core').replace(/\b(system|platform|project|application|solution)\b/gi, '').trim().split(/\s+/).slice(-2).join(' ') || 'Core';
  const ext = (reqs.dependencies || []).filter((d) => d.type === 'External');
  const perf = nfr.filter((n) => n.category === 'Performance').map((n) => n.id);
  const sec = nfr.filter((n) => ['Security', 'Compliance'].includes(n.category)).map((n) => n.id);
  const asyncRefs = refsWhere(/asynchronous|async|queue|event/i);

  const components = [];
  const add = (name, responsibility, technology, reqRefs, category) => {
    const c = { id: `C-${pad(components.length + 1)}`, name, responsibility, technology, reqRefs: uniq(reqRefs), category };
    components.push(c);
    return c;
  };
  const ui = add('Web Client', 'Customer-facing UI: product/cart pages, express checkout button, countdown/cancel, step-up prompts.', stack.frontend, refsWhere(/click|button|tap|page|user|countdown|ui/i), 'Frontend');
  const gw = add('API Gateway / BFF', 'Single entry point: authentication, rate limiting, request validation, routing.', `${stack.cloud} API Management`, fr.map((r) => r.id), 'Integration');
  const auth = add('Identity & Step-up Auth Service', 'Session validation, OAuth2/OIDC tokens, step-up (OTP) challenges.', `${stack.backend} + ${stack.cloud} AD B2C`, refsWhere(/authenticat|otp|login|step-up/i), 'Security');
  const core = add(`${domain} Service`, `Orchestrates the ${domain.toLowerCase()} flow, business rules and constraints (${(reqs.constraints || []).map((c) => c.text).join('; ').slice(0, 120) || 'domain rules'}).`, stack.backend, allIds, 'Backend');
  const data = add('Transactional Data Store', 'Orders, profiles (default shipping/billing), payment tokens only - no raw card data.', stack.data, refsWhere(/store|database|record|saved|profile|token/i).concat(sec), 'Database');
  const cache = perf.length ? add('Distributed Cache', 'Caches profile/payment-token lookups to meet latency targets.', `${stack.cloud} Cache for Redis`, perf, 'Performance') : null;
  const broker = asyncRefs.length ? add('Message Broker', 'Asynchronous fraud-assessment requests/responses and domain events.', `${stack.cloud} Service Bus`, asyncRefs, 'Integration') : null;
  const adapters = ext.map((d) => ({ dep: d, c: add(`${d.name} Adapter`, `Anti-corruption layer for ${d.name}: mapping, timeouts, retries, circuit breaker.`, `${stack.backend} + Polly`, d.refs, 'Integration') }));
  const notify = refsWhere(/sms|otp|email|notif/i).length ? add('Notification Service', 'Sends OTP / notifications via SMS or email providers.', `${stack.backend} + ${stack.cloud} Communication Services`, refsWhere(/sms|otp|email|notif/i), 'Backend') : null;
  const obs = add('Audit, Logging & Monitoring', 'Immutable audit trail of decisions, structured logs, metrics, tracing, alerts.', `${stack.cloud} Monitor + Application Insights`, sec.length ? sec.concat(perf) : allIds, 'DevOps');
  const vault = sec.length ? add('Secrets & Key Management', 'Stores API keys, gateway credentials and encryption keys.', `${stack.cloud} Key Vault`, sec, 'Security') : null;

  const interactions = [];
  const link = (from, to, description, protocol) => from && to && interactions.push({ from: from.id, to: to.id, description, protocol });
  link(ui, gw, 'User actions (checkout, cancel, OTP submit)', 'HTTPS / REST');
  link(gw, auth, 'Validate session / step-up challenge', 'OIDC / JWT');
  link(gw, core, 'Route business requests', 'HTTPS / REST');
  link(core, data, 'Read profile & tokens, persist orders', 'TDS / EF Core');
  link(core, cache, 'Low-latency lookups', 'Redis protocol');
  link(core, broker, 'Publish assessment request / events', 'AMQP');
  for (const { dep, c } of adapters) {
    link(broker && /fraud|score|assess/i.test(dep.name + dep.text) ? broker : core, c, `Call ${dep.name}`, broker ? 'AMQP / async' : 'HTTPS');
  }
  link(core, notify, 'Request OTP / notifications', 'HTTPS / events');
  link(core, obs, 'Audit events, logs, metrics', 'OpenTelemetry');
  link(core, vault, 'Fetch secrets', 'Managed Identity');

  const integrationPoints = ext.map((d, i) => ({
    id: `IP-${pad(i + 1)}`,
    name: d.name,
    type: /gateway/i.test(d.name) ? 'Payment Gateway (REST)' : /sms|email/i.test(d.name) ? 'Messaging Provider' : 'Third-party REST API',
    description: d.text,
    reqRefs: d.refs,
    failureHandling: 'Timeout budget, retry with backoff, circuit breaker, idempotency keys, fallback to standard flow.',
  }));

  const dataFlows = fr.map((r, i) => ({
    id: `DF-${pad(i + 1)}`,
    name: r.title,
    reqRefs: [r.id],
    steps: (r.details?.length ? r.details : [r.description]).filter(Boolean).slice(0, 8),
  }));

  const technology = [
    { area: 'Frontend', choice: stack.frontend, rationale: 'Matches team frontend skills.' },
    { area: 'Backend', choice: stack.backend, rationale: 'Matches team backend skills; high-throughput async I/O.' },
    { area: 'Data', choice: stack.data, rationale: 'Relational integrity for orders; team SQL/EF Core skills.' },
    { area: 'Cloud & Hosting', choice: `${stack.cloud} App Service / AKS`, rationale: 'Team cloud skills; autoscaling for peak load.' },
    { area: 'CI/CD', choice: stack.devops, rationale: 'Automated build, test, security scan and deploy.' },
    { area: 'Testing', choice: stack.testing, rationale: 'Matches QA skills.' },
  ];
  if (cache) technology.push({ area: 'Caching', choice: cache.technology, rationale: 'Required for latency NFRs.' });
  if (broker) technology.push({ area: 'Messaging', choice: broker.technology, rationale: 'Asynchronous processing requirement.' });

  const security = [
    { id: 'S-01', concern: 'Authentication & session security', control: 'OIDC + short-lived JWT, re-validation before order placement.', reqRefs: refsWhere(/authenticat/i) },
    { id: 'S-02', concern: 'Encryption in transit', control: 'TLS 1.2+ everywhere, HSTS, mTLS to third parties where supported.', reqRefs: sec },
    { id: 'S-03', concern: 'Encryption at rest', control: 'TDE on database, Key Vault-managed keys.', reqRefs: sec },
    { id: 'S-04', concern: 'Input validation & OWASP Top 10', control: 'Server-side validation, parameterised queries (EF Core), output encoding, CSP.', reqRefs: fr.map((r) => r.id) },
    { id: 'S-05', concern: 'Audit trail', control: 'Immutable audit of order, fraud score and step-up decisions.', reqRefs: refsWhere(/fraud|flag|block/i) },
  ];
  if (/pci|card|cvv/i.test(JSON.stringify(nfr))) {
    security.push({ id: 'S-06', concern: 'PCI-DSS cardholder data', control: 'Gateway tokenisation; only tokens stored; CVV never persisted; PCI scope minimised.', reqRefs: sec });
  }
  if (refsWhere(/fraud/i).length) security.push({ id: `S-${pad(security.length + 1)}`, concern: 'Fraud & abuse', control: 'Score-based routing, step-up auth, rate limiting, device fingerprinting.', reqRefs: refsWhere(/fraud/i) });
  for (const s of security) if (!s.reqRefs.length) s.reqRefs = allIds.slice(0, 1);

  return {
    overview: `Proposed ${domain} architecture: a ${stack.frontend} client calls an API gateway in front of a ${stack.backend} domain service. ${ext.length ? `External dependencies (${ext.map((d) => d.name).join(', ')}) are isolated behind adapters with resilience policies.` : ''} ${broker ? 'Fraud/third-party calls are processed asynchronously via a message broker.' : ''} Only payment tokens are stored; secrets are held in a key vault.`.replace(/\s+/g, ' ').trim(),
    components,
    interactions,
    integrationPoints,
    dataFlows,
    technology,
    security,
    assumptions: (reqs.assumptions || []).map((a) => a.text).concat(['Peak load figures in NFRs apply to the checkout API only.']),
    openQuestions: (reqs.ambiguities || []).slice(0, 8).map((a) => `${a.ref}: ${a.question}`),
  };
}

// ======================= Development tasks =======================
export function planTasks(reqs, arch, team) {
  const tasks = [];
  const byComp = {};
  const add = (t) => {
    const task = {
      id: `T-${pad(tasks.length + 1, 3)}`,
      status: 'To Do',
      dependsOn: [],
      acceptanceCriteria: [],
      ...t,
    };
    task.skills = skillsFor(task.type, team);
    task.estimateHours = { S: 4, M: 8, L: 16, XL: 24 }[task.complexity] || 8;
    tasks.push(task);
    return task;
  };
  const cicd = add({ title: 'Set up repository, CI/CD pipeline and environments', description: 'Branching strategy, build/test/scan pipeline, IaC for dev/test/prod.', type: 'DevOps', complexity: 'M', priority: 'P1', reqRefs: (reqs.nonFunctional || []).map((n) => n.id).slice(0, 2), componentRef: arch.components.find((c) => c.category === 'DevOps')?.id || '' });
  for (const c of arch.components) {
    const type = c.category === 'Database' ? 'Database' : c.category === 'Frontend' ? 'Frontend' : c.category === 'Security' ? 'Security' : c.category === 'DevOps' ? 'DevOps' : c.category === 'Performance' ? 'Performance' : c.category === 'Integration' ? 'Integration' : 'Backend';
    byComp[c.id] = add({
      title: `Implement ${c.name}`,
      description: `${c.responsibility} Technology: ${c.technology}.`,
      type,
      complexity: /Adapter|Service$/.test(c.name) ? 'L' : 'M',
      priority: c.reqRefs.length > 2 ? 'P1' : 'P2',
      reqRefs: c.reqRefs,
      componentRef: c.id,
      dependsOn: [cicd.id],
    });
  }
  const core = arch.components.find((c) => c.category === 'Backend' && /Service$/.test(c.name));
  const ui = arch.components.find((c) => c.category === 'Frontend');
  const dataC = arch.components.find((c) => c.category === 'Database');
  if (core && dataC) byComp[core.id].dependsOn.push(byComp[dataC.id].id);

  for (const r of reqs.functional || []) {
    const be = add({
      title: `${r.id}: ${r.title} - business logic & API`,
      description: r.description,
      type: 'Backend',
      complexity: (r.details?.length || 0) > 3 ? 'XL' : 'L',
      priority: r.priority === 'Must' ? 'P1' : 'P2',
      reqRefs: [r.id],
      componentRef: core?.id || '',
      dependsOn: [core && byComp[core.id].id].filter(Boolean),
      acceptanceCriteria: r.acceptanceCriteria || [],
    });
    for (const ip of (arch.integrationPoints || []).filter((p) => p.reqRefs.includes(r.id))) {
      const adapter = arch.components.find((c) => c.name.startsWith(ip.name));
      if (adapter) be.dependsOn.push(byComp[adapter.id].id);
    }
    if (ui && ui.reqRefs.includes(r.id)) {
      add({
        title: `${r.id}: ${r.title} - UI`,
        description: `User-facing flow for ${r.title}.`,
        type: 'Frontend',
        complexity: 'M',
        priority: be.priority,
        reqRefs: [r.id],
        componentRef: ui.id,
        dependsOn: [be.id, byComp[ui.id].id],
        acceptanceCriteria: r.acceptanceCriteria || [],
      });
    }
  }
  for (const ip of arch.integrationPoints || []) {
    add({ title: `Contract tests & resilience for ${ip.name}`, description: ip.failureHandling, type: 'Integration', complexity: 'M', priority: 'P1', reqRefs: ip.reqRefs, componentRef: arch.components.find((c) => c.name.startsWith(ip.name))?.id || '', dependsOn: [byComp[arch.components.find((c) => c.name.startsWith(ip.name))?.id]?.id].filter(Boolean) });
  }
  for (const n of reqs.nonFunctional || []) {
    const isPerf = n.category === 'Performance';
    add({
      title: `${n.id}: ${isPerf ? 'Performance engineering & load test' : 'Implement and verify'} - ${n.title}`,
      description: `${n.description} ${n.metric ? `Target: ${n.metric}.` : ''}`.trim(),
      type: isPerf ? 'Performance' : ['Security', 'Compliance'].includes(n.category) ? 'Security' : 'Backend',
      complexity: isPerf ? 'XL' : 'L',
      priority: 'P1',
      reqRefs: [n.id],
      componentRef: isPerf ? arch.components.find((c) => c.category === 'Performance')?.id || core?.id || '' : arch.components.find((c) => c.category === 'Security')?.id || '',
      dependsOn: tasks.filter((t) => t.type === 'Backend' && t.reqRefs.some((x) => x.startsWith('FR'))).map((t) => t.id).slice(0, 3),
    });
  }
  for (const t of tasks) t.dependsOn = uniq(t.dependsOn).filter((d) => d !== t.id);
  return { tasks, sequencingNotes: 'Foundation (CI/CD, data, identity) first, then core service and adapters, then feature APIs, UI, and finally NFR hardening and load tests.' };
}

// ======================= QA test cases =======================
export function generateTests(reqs, arch, tasksDoc) {
  const tests = [];
  const tasks = tasksDoc.tasks || [];
  const taskRefs = (ids) => tasks.filter((t) => t.reqRefs.some((r) => ids.includes(r))).map((t) => t.id).slice(0, 4);
  const add = (t) => tests.push({ id: `TC-${pad(tests.length + 1, 3)}`, status: 'Draft', preconditions: '', priority: 'Medium', ...t, taskRefs: t.taskRefs || taskRefs(t.reqRefs) });
  const featureTasks = (reqId) => tasks.filter((t) => t.reqRefs.length === 1 && t.reqRefs[0] === reqId).map((t) => t.id);

  for (const r of reqs.functional || []) {
    const text = [r.description, ...(r.details || []), ...(r.acceptanceCriteria || [])].join(' ');
    add({ title: `${r.id} happy path: ${r.title}`, type: 'Positive', reqRefs: [r.id], taskRefs: [...new Set([...featureTasks(r.id), ...taskRefs([r.id])])], priority: 'High', preconditions: 'Authenticated user with valid saved profile data.', steps: (r.details?.length ? r.details : [r.description]).slice(0, 6), expected: `${r.title} completes successfully as described in ${r.id}.` });
    for (const ac of r.acceptanceCriteria || []) {
      const negative = /\b(block|must not|cannot|without|reject|prevent|no )\b/i.test(ac);
      add({ title: `${r.id} AC: ${ac.slice(0, 90)}`, type: negative ? 'Negative' : 'Positive', reqRefs: [r.id], priority: 'High', steps: ['Set up the condition described in the acceptance criterion.', 'Execute the flow.', 'Observe system response and database state.'], expected: ac });
    }
    for (const s of [...(r.details || []), r.description].filter((x) => /\b(block|halt|flag|reject|fail|require)\b/i.test(x || ''))) {
      add({ title: `${r.id} negative: ${s.slice(0, 90)}`, type: 'Negative', reqRefs: [r.id], priority: 'High', steps: ['Create the triggering condition.', 'Submit the request.', 'Verify the system blocks / halts / requires the extra step.'], expected: s });
    }
    for (const b of boundaries(text)) {
      const values = b.kind === 'below' ? [b.value - 1, b.value] : b.kind === 'above' ? [b.value, b.value + 1] : [b.value];
      for (const v of values) add({ title: `${r.id} boundary: ${b.phrase} -> value ${v}`, type: 'Boundary', reqRefs: [r.id], priority: 'High', steps: [`Prepare input so the evaluated value equals ${v}.`, 'Submit the request.', 'Record which branch the system takes.'], expected: `Behaviour at ${v} matches the clarified rule for "${b.phrase}" (see ambiguity log).` });
    }
    for (const m of text.matchAll(/(\d+)[- ]second/gi)) {
      const n = Number(m[1]);
      add({ title: `${r.id} timing boundary: action at ${n - 0.1}s vs ${n + 0.1}s of the ${n}-second window`, type: 'Boundary', reqRefs: [r.id], priority: 'High', steps: [`Trigger the ${n}-second window.`, `Act at ${n - 0.1}s; repeat at ${n + 0.1}s.`], expected: `Before ${n}s the action is honoured; after ${n}s the default behaviour applies, with no duplicate records.` });
    }
    if (/click|tap|button|countdown|page|screen|select|book|join|link|form|view/i.test(text)) {
      add({ title: `${r.id} usability & accessibility`, type: 'Usability', reqRefs: [r.id], steps: ['Navigate using keyboard only and a screen reader.', 'Check visible focus, labels, timer announcements and contrast.'], expected: 'Flow is operable by keyboard, announced by screen readers and meets WCAG 2.1 AA.' });
    }
    add({ title: `${r.id} regression: existing flows unaffected`, type: 'Regression', reqRefs: [r.id], steps: ['Run standard (non-express) flow end to end.', 'Run related existing regression suite.'], expected: 'No change in behaviour of existing flows.' });
  }
  for (const c of reqs.constraints || []) {
    for (const b of boundaries(c.text)) {
      for (const v of b.kind === 'above' ? [b.value, b.value + 0.01] : [b.value]) {
        add({ title: `Constraint boundary: ${b.phrase} -> ${v}`, type: 'Boundary', reqRefs: (reqs.functional || []).map((f) => f.id).slice(0, 1), priority: 'High', steps: [`Create cart / input with value ${v}.`, 'Attempt the express flow.'], expected: `Constraint "${c.text.slice(0, 100)}" enforced correctly at ${v}.` });
      }
    }
  }
  for (const ip of arch.integrationPoints || []) {
    const ipTasks = tasks.filter((t) => t.title.includes(ip.name)).map((t) => t.id);
    add({ title: `Integration: ${ip.name} success path`, type: 'Integration', reqRefs: ip.reqRefs, taskRefs: ipTasks.length ? ipTasks : undefined, priority: 'High', steps: [`Configure ${ip.name} sandbox.`, 'Execute flow that calls the integration.', 'Validate request/response contract.'], expected: 'Contract honoured; response mapped correctly.' });
    add({ title: `Integration: ${ip.name} timeout / unavailable`, type: 'Integration', reqRefs: ip.reqRefs, taskRefs: ipTasks.length ? ipTasks : undefined, priority: 'High', steps: [`Simulate ${ip.name} timeout and 5xx errors.`, 'Execute flow.'], expected: ip.failureHandling });
  }
  for (const s of arch.security || []) {
    const secTasks = tasks.filter((t) => t.type === 'Security' || (/audit/i.test(s.concern) && /audit/i.test(t.title)) || (/secret|key|encrypt/i.test(s.control) && /secret|key/i.test(t.title))).map((t) => t.id);
    add({ title: `Security: ${s.concern}`, type: 'Security', reqRefs: s.reqRefs, taskRefs: secTasks.length ? secTasks : undefined, priority: 'High', steps: [`Verify control: ${s.control}`, 'Attempt bypass (tampered token / injection / direct DB inspection as applicable).'], expected: `Control "${s.control}" is effective; no bypass possible.` });
  }
  for (const n of (reqs.nonFunctional || []).filter((x) => !['Performance', 'Security', 'Compliance'].includes(x.category))) {
    const type = n.category === 'Usability' ? 'Usability' : n.category === 'Availability' ? 'Performance' : 'Regression';
    add({ title: `${n.category}: ${n.title}`, type, reqRefs: [n.id], priority: 'High', steps: n.category === 'Availability' ? ['Run under steady load.', 'Kill one instance / zone and the primary database node.', 'Measure downtime and data loss.'] : ['Verify the requirement in a production-like environment.'], expected: n.metric ? `Meets ${n.metric}` : `${n.description || n.title} (target to be confirmed - see ambiguity log)` });
  }
  for (const n of (reqs.nonFunctional || []).filter((x) => ['Security', 'Compliance'].includes(x.category))) {
    if (!tests.some((t) => t.reqRefs.includes(n.id))) add({ title: `${n.category} verification: ${n.title}`, type: 'Security', reqRefs: [n.id], priority: 'High', steps: ['Review data at rest and in transit for the protected data.', 'Attempt unauthorised access.'], expected: n.description });
  }
  for (const n of (reqs.nonFunctional || []).filter((x) => x.category === 'Performance')) {
    add({ title: `Performance: ${n.title}`, type: 'Performance', reqRefs: [n.id], taskRefs: tasks.filter((t) => t.reqRefs.includes(n.id) && /Performance|Cache|Broker|Gateway/i.test(`${t.type} ${t.title}`)).map((t) => t.id), priority: 'High', preconditions: 'Production-like environment; third-party APIs stubbed with fixed latency.', steps: ['Ramp load to target throughput.', 'Hold for 15 minutes.', 'Measure p95/p99 latency excluding third-party time.'], expected: n.metric ? `Meets ${n.metric}` : n.description });
  }
  return { testCases: tests };
}
