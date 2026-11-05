# Test plans (Playwright planner agent output)

The **playwright-test-planner** agent explores the running app and saves Markdown test plans here,
for example `specs/approval-gates.md`. The **playwright-test-generator** agent turns a plan into
`e2e/*.spec.ts` tests, and the **playwright-test-healer** agent fixes tests that start failing.

Every plan and test starts from `e2e/seed.spec.ts` (signed in as the PM). See docs/HANDBOOK.md, section 7.
