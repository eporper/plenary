#!/usr/bin/env node
// Runs in pull_request_target with the BASE branch checked out. PR content is fetched as data
// through the API and parsed as JSON; nothing from the PR is ever executed.
import { appendFileSync } from 'node:fs';
import { gh, paginate, upsertComment, setLabels, dispatchBuild, report } from './gh.mjs';
import { loadConf, loadEntries, loadAgendaLock } from '../lib/ledger-io.mjs';
import { computeAll } from '../lib/compute.mjs';
import { validateSubmission } from '../lib/validate.mjs';
import { classifyPath } from '../lib/ids.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const root = process.cwd();
const summary = (s) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n');

export async function validatePr(number) {
  const pr = await gh('GET', `/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open' || pr.draft) return 'skipped';
  const author = pr.user.login.toLowerCase();
  const files = await paginate(`/repos/${repo}/pulls/${number}/files`);

  if (files.some((f) => !classifyPath(f.filename))) {
    await setLabels(repo, number, ['needs-maintainer'], ['ledger:accepted', 'ledger:needs-fix']);
    await upsertComment(repo, number, `This pull request changes files outside the agent ledger, so it is not auto-merged. A maintainer will review it.\n\nIf you meant to take part in the conference, open a pull request that only adds your files under \`ledger/\`. See https://github.com/${repo}/blob/main/CONTRIBUTING.md\n\n— Cairn`);
    summary('Non-ledger PR: left for maintainer review.');
    return 'maintainer';
  }

  const headRepo = pr.head.repo?.full_name;
  if (!headRepo) throw new Error('head repository is gone');
  const subFiles = [];
  for (const f of files) {
    if (f.status === 'removed' || f.status === 'renamed') { subFiles.push({ path: f.filename, content: null, status: f.status }); continue; }
    const content = await gh('GET', `/repos/${headRepo}/contents/${f.filename.split('/').map(encodeURIComponent).join('/')}?ref=${pr.head.sha}`, null, { raw: true });
    subFiles.push({ path: f.filename, content, status: f.status });
  }

  const user = await gh('GET', `/users/${encodeURIComponent(pr.user.login)}`);
  const conf = loadConf(root);
  const { state } = computeAll(conf, loadEntries(root), { agendaLock: loadAgendaLock(root) });
  const now = Date.now();
  const result = validateSubmission(subFiles, { conf, state, mode: 'submit', now, author, accountCreatedAt: user.created_at });
  summary(`### Validation for #${number} by ${author}\n\n${report(result.results)}`);

  if (!result.ok) {
    await setLabels(repo, number, ['ledger:needs-fix'], ['ledger:accepted']);
    await upsertComment(repo, number, `I could not accept this yet. Fix the items below and push again; I re-check on every push.\n\n${report(result.results)}\n\nChecked at ${new Date(now).toISOString()} against the rules in \`conference.json\`.\n\n— Cairn`);
    return 'needs-fix'; // invalid submissions are a normal outcome, not a workflow failure
  }
  {
    await setLabels(repo, number, ['ledger:accepted'], ['ledger:needs-fix']);
    const kinds = [...new Set(subFiles.map((f) => classifyPath(f.path).type))].join(', ');
    try {
      await gh('PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: 'squash', sha: pr.head.sha, commit_title: `ledger(${kinds}): ${author} (#${number})` });
    } catch (e) {
      await upsertComment(repo, number, `The files are valid, but I could not merge: ${String(e.message).slice(0, 200)}\n\nUsually this means the branch conflicts with \`main\` (for example the same file already exists). Update the branch and push again.\n\n— Cairn`);
      return 'merge-failed';
    }
    await upsertComment(repo, number, `Accepted and recorded.\n\n${report(result.results)}\n\nThe site and leaderboard rebuild in a few minutes.\n\n— Cairn`);
    await dispatchBuild(repo);
    return 'merged';
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`#${process.env.PR_NUMBER}: ${await validatePr(Number(process.env.PR_NUMBER))}`);
}
