// Retrieval agent: indexes approved project files into chunks and finds supporting evidence
// (BM25 keyword ranking - no external vector store needed for a local deployment).

const STOP = new Set('a an the and or of to in on for with by is are be must should will can from that this as at it its our their all any each if not no than then into via per up'.split(' '));

const tokenize = (s) => String(s).toLowerCase().replace(/[^a-z0-9$.-]+/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));

export function buildIndex(paragraphs) {
  // Chunk: group paragraphs under the most recent requirement id / heading.
  const chunks = [];
  let current = null;
  for (const p of paragraphs) {
    const id = p.match(/^((?:FR|NFR|BR|REQ|UR|SR)[-_]?\d+)/i)?.[1]?.toUpperCase();
    const heading = /^\d+\.\s+\S/.test(p);
    if (id || heading || !current) {
      current = { id: `C${chunks.length + 1}`, reqId: id || null, heading: p.slice(0, 100), text: p };
      chunks.push(current);
    } else {
      current.text += `\n${p}`;
    }
  }
  const docs = chunks.map((c) => tokenize(c.text));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length);
  return { chunks, docs, df, avgLen };
}

export function search(index, query, k = 3) {
  const q = tokenize(query);
  const N = index.docs.length;
  const scored = index.docs.map((doc, i) => {
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (doc.length / index.avgLen))));
    }
    return { chunk: index.chunks[i], score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

/** Attach evidence to each generated item: the source chunk(s) that best support it. */
export function collectEvidence(index, items) {
  const evidence = {};
  for (const it of items) {
    if (!it?.id) continue;
    const refs = it.reqRefs || (it.ref ? [it.ref] : []);
    const direct = index.chunks.filter((c) => c.reqId && refs.includes(c.reqId));
    const hits = direct.length
      ? direct.slice(0, 2).map((c) => ({ chunk: c, score: 99 }))
      : search(index, [it.title, it.name, it.description, it.text].filter(Boolean).join(' '), 2);
    if (hits.length) {
      evidence[it.id] = hits.map((h) => ({
        chunkId: h.chunk.id,
        reqId: h.chunk.reqId,
        snippet: h.chunk.text.slice(0, 280),
        score: Math.round(h.score * 100) / 100,
      }));
    }
  }
  return evidence;
}

export function flattenItems(stage, content) {
  if (stage === 'requirements') {
    return [...(content.functional || []), ...(content.nonFunctional || []), ...(content.ambiguities || []), ...(content.gaps || []), ...(content.risks || [])];
  }
  if (stage === 'architecture') return [...(content.components || []), ...(content.integrationPoints || []), ...(content.security || [])];
  if (stage === 'tasks') return content.tasks || [];
  if (stage === 'tests') return content.testCases || [];
  return [];
}
