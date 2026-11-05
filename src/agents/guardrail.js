// Governance / guardrail agent: flags sensitive data, prompt-injection attempts, policy concerns
// and unsupported claims (generated items that cannot be traced back to a source requirement).

const PATTERNS = [
  { type: 'EMAIL', severity: 'medium', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: 'PHONE', severity: 'medium', re: /(?<!\w)(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3}\)?[\s-]?)\d{3}[\s-]?\d{4}(?!\w)/g },
  { type: 'SSN', severity: 'high', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'AADHAAR/PAN', severity: 'high', re: /\b(?:\d{4}\s\d{4}\s\d{4}|[A-Z]{5}\d{4}[A-Z])\b/g },
  { type: 'API_KEY/SECRET', severity: 'high', re: /\b(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:api[_-]?key|secret|password|pwd|token)\s*[:=]\s*\S{6,})/gi },
  { type: 'IP_ADDRESS', severity: 'low', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

const INJECTION = [
  /ignore (?:all |any )?(?:previous|prior|above) instructions/i,
  /disregard (?:the )?(?:system|previous) (?:prompt|instructions)/i,
  /you are now (?:a|an|in) /i,
  /reveal (?:your|the) (?:system prompt|instructions)/i,
  /\b(?:act as|pretend to be) (?:the )?(?:system|admin|developer mode)/i,
  /<\s*\/?\s*(?:system|assistant)\s*>/i,
];

const POLICY_TERMS = [
  { re: /\b(?:store|save|persist|log)\w*\b[^.]{0,60}\b(?:cvv|cvc|full card number|raw card|pan)\b/i, concern: 'Storing raw cardholder data violates PCI-DSS' },
  { re: /\bplain ?text\b[^.]{0,40}\bpassword/i, concern: 'Plaintext password handling' },
  { re: /\bdisable\w*\b[^.]{0,30}\b(?:tls|ssl|https|authentication|mfa)\b/i, concern: 'Disabling a security control' },
];

function luhn(num) {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function mask(s) {
  return s.length <= 4 ? '****' : `${s.slice(0, 2)}${'*'.repeat(Math.max(2, s.length - 4))}${s.slice(-2)}`;
}

/** Scan free text; returns findings and a redacted copy safe to send to the LLM. */
export function scanText(text, where = 'input') {
  const findings = [];
  let redacted = text;
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    if (luhn(m[0])) {
      findings.push({ type: 'CARD_NUMBER', severity: 'high', where, sample: mask(m[0].replace(/\D/g, '')) });
      redacted = redacted.replace(m[0], '[REDACTED_CARD]');
    }
  }
  for (const p of PATTERNS) {
    // Scan the progressively redacted text so one value is not reported twice (e.g. a card as an ID number).
    for (const m of redacted.matchAll(p.re)) {
      findings.push({ type: p.type, severity: p.severity, where, sample: mask(m[0]) });
      redacted = redacted.split(m[0]).join(`[REDACTED_${p.type.split('/')[0]}]`);
    }
  }
  for (const re of INJECTION) {
    const m = text.match(re);
    if (m) findings.push({ type: 'PROMPT_INJECTION', severity: 'high', where, sample: m[0].slice(0, 60) });
  }
  for (const p of POLICY_TERMS) {
    const m = text.match(p.re);
    if (m) findings.push({ type: 'POLICY', severity: 'medium', where, sample: m[0].slice(0, 80), concern: p.concern });
  }
  return { findings, redacted };
}

/**
 * Prepare an uploaded document for the agents: redact sensitive values paragraph by paragraph and
 * quarantine paragraphs containing prompt-injection, so neither reaches the LLM or the stored outputs.
 */
export function sanitizeDocument(doc) {
  const findings = [];
  const paragraphs = [];
  const quarantined = [];
  for (const p of doc.paragraphs || []) {
    const r = scanText(p, 'requirements document');
    findings.push(...r.findings);
    if (r.findings.some((f) => f.type === 'PROMPT_INJECTION')) { quarantined.push(p); continue; }
    paragraphs.push(r.redacted);
  }
  for (const q of quarantined) findings.push({ type: 'QUARANTINED', severity: 'high', where: 'requirements document', sample: q.slice(0, 80), concern: 'Paragraph excluded from analysis (instructions addressed to the AI)' });
  return { doc: { ...doc, paragraphs, text: paragraphs.join('\n') }, findings, quarantined };
}

/** Check a generated artifact: sensitive data in output + unsupported (untraceable) claims. */
export function reviewOutput(stage, content, knownReqIds) {
  const findings = [];
  const { findings: textFindings } = scanText(JSON.stringify(content), 'output');
  // A requirement "policy" sentence quoted back (e.g. "No raw CVV may be stored") is fine; only keep real data leaks.
  findings.push(...textFindings.filter((f) => f.type !== 'POLICY' && f.type !== 'IP_ADDRESS'));

  const known = new Set(knownReqIds);
  const checkRefs = (items, label) => {
    for (const it of items || []) {
      const refs = it.reqRefs || [];
      if (!refs.length) {
        findings.push({ type: 'UNSUPPORTED_CLAIM', severity: 'low', where: `${label} ${it.id || it.name}`, concern: 'No source requirement referenced' });
      }
      const unknown = refs.filter((r) => !known.has(r));
      if (unknown.length && known.size) {
        findings.push({ type: 'UNKNOWN_REFERENCE', severity: 'medium', where: `${label} ${it.id || it.name}`, concern: `References unknown requirement(s): ${unknown.join(', ')}` });
      }
    }
  };
  if (stage === 'architecture') { checkRefs(content.components, 'Component'); checkRefs(content.security, 'Security control'); }
  if (stage === 'tasks') checkRefs(content.tasks, 'Task');
  if (stage === 'tests') checkRefs(content.testCases, 'Test');
  return { findings, passed: !findings.some((f) => f.severity === 'high') };
}
