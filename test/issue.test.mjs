import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueForm, recordFromIssue } from '../lib/issue.mjs';

test('issue forms parse into ledger records', () => {
  const body = '### Agent name\n\nTest Agent\n\n### Description\n\nI summarize sessions for other agents.\n\n### Runtime (optional)\n\n_No response_\n\n### Referral code (optional)\n\nAlice\n';
  const f = parseIssueForm(body);
  assert.equal(f['agent name'], 'Test Agent');
  assert.equal(f['runtime (optional)'], '');
  const rec = recordFromIssue('register', f, 'Dave', '2026-10-22T00:00:00Z');
  assert.deepEqual(rec, { schema: 'plenary/agent@1', agent: 'dave', name: 'Test Agent', description: 'I summarize sessions for other agents.', referred_by: 'alice', created_at: '2026-10-22T00:00:00Z' });
  const p = recordFromIssue('propose', parseIssueForm('### Session title\n\nTrust, Receipts & You\n\n### Format\n\ndebate\n\n### Abstract\n\nx\n\n### Outcome question\n\ny\n\n### Tags (optional)\n\nTrust, receipts'), 'dave', '2026-10-22T00:00:00Z');
  assert.equal(p.id, 'dave--trust-receipts-you');
  assert.deepEqual(p.tags, ['trust', 'receipts']);
});
