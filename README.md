# AI SDLC Copilot — FY27 NFTS Code-a-thon, Use Case 2

AI-assisted software development lifecycle: **Word requirements + Excel team template → requirements analysis → architecture plan → development tasks → QA test cases**, with a human approving every stage. Everything is audited, and approved output can be exported or pushed to **Azure DevOps** or **Jira**.

```
Login/Register → Upload & validate → [Gate 1] Requirements → [Gate 2] Architecture (Architect only)
   → [Gate 3] Dev tasks & assignment (PM) → [Gate 4] QA test cases (QA) → Export / ADO / Jira → Audit
```

## Run it

Requires Node.js 22.13+ (uses the built-in `node:sqlite`, so there are no native builds).

```bash
npm install
cp .env.example .env        # set APP_SECRET, and the Azure OpenAI key if you have one
npm start                   # http://127.0.0.1:3000
npm test                    # API, agent unit and data-integrity tests (node:test)
npm run test:e2e            # browser tests (Playwright, headless Microsoft Edge)
npm run load                # load test with latency budgets
```

Demo accounts (password = `DEMO_PASSWORD` in `.env`): `admin@`, `pm@`, `architect@`, `dev@`, `qa@` followed by `demo.local`.
The handbook's sample input files are in [samples/](samples/).

### AI engine
* **Azure OpenAI** (`gpt-5-5`, API version `2024-10-21`): set `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY`.
* **Offline engine**: used automatically when no key is set, or when the AI call fails. It is a rule-based version of every agent, so the full demo works without network access. The badge at the top right of each project shows which engine is active.

## Agents ([src/agents/](src/agents/))

| Agent | File | What it does |
|---|---|---|
| Orchestrator | `orchestrator.js` | Runs the workflow, enforces the 4 gates, blocks downstream generation until upstream approval, detects **stale** versions when inputs change, and versions every output |
| Specialists | `specialists.js`, `mock.js` | Requirements analyst (FR/NFR, ambiguities, boundaries, gaps, dependencies, risks, assumptions), architect (components, interactions, integrations, data flows, tech stack from team skills, security), delivery planner (tasks, dependencies, sequencing, complexity and hours), QA designer (positive, negative, boundary, integration, regression, security, usability and performance tests) |
| Planner / assignment | `assign.js` | Assigns tasks and tests deterministically from the team sheet by skill fit and capacity, explains each choice, sequences tasks topologically and detects dependency cycles |
| Retrieval | `retrieval.js` | Chunks and indexes the approved files (BM25), grounds prompts, and attaches 📎 evidence snippets to every generated item |
| Review / critic | `critic.js` | Scores each output 0–100: traceability coverage, missing acceptance criteria, unknown references, cycles, workload imbalance, missing test types. With Azure OpenAI it adds a qualitative review, and output scoring below the threshold is **self-revised** once |
| Governance / guardrail | `guardrail.js` | Redacts PII, card numbers (Luhn-checked) and secrets **before** sending text to the LLM; flags prompt injection, policy violations (e.g. storing CVV) and **unsupported claims** (items with no or unknown requirement references). High-severity findings require explicit acknowledgement before approval |
| **Review-feedback** (extra) | `feedback.js` | The reviewer writes suggestions and a new version is regenerated, with a change log and an item-level diff (rows added or modified are highlighted). With Azure OpenAI it accepts any free text. Offline it understands commands like `assign T-014 to Asha`, `priority of T-022 to P1`, `estimate T-017 to 24`, `remove TC-006`, `add task: …`, `add test: …`, `use PostgreSQL instead of Azure SQL`, `resolve A-05: …`, `add risk/assumption/component/security control: …`, and can also auto-fix the critic's coverage findings |

## Integrations (extra) — [src/exporters/](src/exporters/)
* **Downloads:** Excel workbook (requirements, analysis, architecture, security, tasks, tests, traceability, approvals), Jira import CSV, Azure DevOps import CSV (with hierarchy), Markdown report, JSON bundle. CSV cells are protected against formula injection.
* **Azure DevOps Boards (REST 7.1):** creates User Story / PBI work items, Tasks as children with predecessor links, and Test Cases with real `TCM.Steps` and *Tests* links. Area and iteration paths and an assignee map are optional.
* **Jira Cloud (REST v3):** creates an Epic or Story per requirement, Tasks with parent and *Blocks* links, and test cases with labels. The description is in ADF.
* **Dry run** shows the exact payloads without sending anything. Pushes are **idempotent**: items already created are skipped. **Only approved versions** can be pushed. PATs and API tokens are AES-256-GCM encrypted at rest and never returned to the browser. The Jira URL has an SSRF guard (https only; private hosts are blocked unless enabled).

## Common capabilities → implementation

| Requirement | Implementation |
|---|---|
| Role-based access | Roles ADMIN / PM / ARCHITECT / DEVELOPER / QA, scoped to project membership, with a stage × action permission matrix (`security.js`). Example: only the Architect approves the architecture |
| Registration & accounts | Self-registered accounts start inactive and need admin activation; role escalation to ADMIN is blocked. Password policy, lockout after 5 failed logins, change and reset password, deactivation |
| Human-in-the-loop | 4 gates; approve, reject (reason required) and comment; edits create new versions; reviewer identity, timestamp, comments and version are recorded |
| Data security | httpOnly SameSite=Strict JWT cookie, CSRF header, Helmet CSP, rate limiting, parameterised SQL, PII redaction before the LLM, encrypted integration secrets, no stack traces sent to clients, admin project deletion removes stored files |
| Audit & traceability | Every login, upload, rejection, generation, edit, decision, denial, export and push is logged and exportable to CSV; a requirement → component → task → test matrix |
| Secure file handling | Extension, MIME type and ZIP magic-byte checks; OOXML structure check; macro (`vbaProject.bin`) and zip-bomb rejection; size limit; structure and completeness validation (required columns, numeric capacity, duplicates); random on-disk names; SHA-256 hashing; versioning |

## Quality assurance
| Suite | File | What it covers |
|---|---|---|
| API end-to-end | `test/api.test.js` | Auth, RBAC, file validation, all 4 gates, feedback agent, exports, integrations, audit, panel pack |
| Agent unit tests | `test/agents.test.js` | Guardrail (cards, secrets, 6 injection variants, false positives), retrieval, assignment, critic, and natural-language edge cases for the feedback agent (ambiguous names, unknown IDs, invalid values, multiple commands, quotes and `$&`, empty / very long / emoji / non-English text) |
| Data integrity | `test/integrity.test.js` | Concurrent generation and approval, immutable history, tampered edits, rejected uploads leave nothing behind, project isolation, lockout and deactivation, audit coverage |
| Browser end-to-end | `e2e/workflow.spec.js` | Sign-in errors, upload rejection in the UI, XSS safety, feedback agent, approvals, role restrictions, Mermaid diagram, inline edit, Excel download |
| Load | `scripts/load-test.mjs` | 20 projects end to end concurrently, plus 200 reads from 50 users; fails if a p95 budget is missed |
| Test-case catalog | [docs/QA-Test-Catalog.xlsx](docs/QA-Test-Catalog.xlsx) | 70 cases (functional, non-functional, natural-language edge cases), each mapped to its automated test, with a live summary |
| Panel stress inputs | [samples/panel-pack/](samples/panel-pack/PANEL-SCENARIO.md) | 10 adversarial files and the expected behaviour at every step |

## Project layout
```
src/server.js            Express app, security middleware
src/routes/              auth, admin, projects (files, stages, reviews, exports, integrations)
src/agents/              orchestrator, specialists, mock engine, retrieval, critic, guardrail, feedback, assign
src/exporters/           Excel/CSV/Markdown bundle, ADO & Jira push
public/                  single-page UI (vanilla JS, Mermaid component diagram)
test/, e2e/, scripts/    unit, integrity, API, browser and load tests
```

## Known limitations
* Live ADO and Jira pushes are implemented against the documented REST APIs but have only been exercised through dry runs. Run **Test connection** first with a real PAT or token.
* Offline-engine output is rule-based and tuned for documents shaped like the sample (FR-/NFR- IDs, labelled sections). Use Azure OpenAI for arbitrary documents.
* SQLite and local file storage suit a single-machine demo. For production, swap in Azure SQL + Blob Storage + Key Vault.
