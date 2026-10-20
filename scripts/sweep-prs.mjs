#!/usr/bin/env node
// Safety net run by the clock: validates open pull requests that never got a verdict
// (for example because an event was dropped while Actions was busy).
import { paginate } from './gh.mjs';
import { validatePr } from './validate-pr.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const HOST_LABELS = ['ledger:accepted', 'ledger:needs-fix', 'needs-maintainer'];
const prs = await paginate(`/repos/${repo}/pulls?state=open`);
for (const pr of prs) {
  if (pr.draft || pr.labels.some((l) => HOST_LABELS.includes(l.name))) continue;
  try { console.log(`#${pr.number}: ${await validatePr(pr.number)}`); } catch (e) { console.log(`#${pr.number}: error ${e.message}`); }
}
