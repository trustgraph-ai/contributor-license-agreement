const core = require('@actions/core');
const github = require('@actions/github');

const SIGN_PHRASE = 'I have read the CLA Document and I hereby sign the CLA';
const CLA_ORG = 'trustgraph-ai';
const CLA_REPO = 'contributor-license-agreement';
const SIGNATURES_PATH = 'signatures/cla.json';
const CLA_BRANCH = 'main';
const CLA_DOC_URL = 'https://github.com/trustgraph-ai/contributor-license-agreement/blob/main/README.md';
const INDIVIDUAL_CLA_URL = 'https://github.com/trustgraph-ai/contributor-license-agreement/blob/main/Fiduciary-Contributor-License-Agreement.md';
const ENTITY_CLA_URL = 'https://github.com/trustgraph-ai/contributor-license-agreement/blob/main/Entity-Fiduciary-Contributor-License-Agreement.md';
const STATUS_CONTEXT = 'CLA Assistant';

function isAllowlisted(username, allowlist) {
  const lower = username.toLowerCase();
  return allowlist.some(entry => {
    if (entry.endsWith('*')) {
      return lower.startsWith(entry.slice(0, -1));
    }
    return lower === entry;
  });
}

async function loadSignatures(octokit) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner: CLA_ORG,
      repo: CLA_REPO,
      path: SIGNATURES_PATH,
      ref: CLA_BRANCH,
    });
    const content = Buffer.from(response.data.content, 'base64').toString('utf8');
    const data = JSON.parse(content);
    return { data, sha: response.data.sha };
  } catch (err) {
    if (err.status === 404) {
      // File doesn't exist yet - create empty structure
      return { data: { signedContributors: [] }, sha: null };
    }
    throw err;
  }
}

async function saveSignatures(octokit, data, sha) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const params = {
    owner: CLA_ORG,
    repo: CLA_REPO,
    path: SIGNATURES_PATH,
    branch: CLA_BRANCH,
    message: `CLA signature recorded`,
    content,
  };
  if (sha) params.sha = sha;
  await octokit.rest.repos.createOrUpdateFileContents(params);
}

async function getPRAuthors(octokit, owner, repo, prNumber) {
  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  const authors = new Set();
  for (const commit of commits) {
    if (commit.author && commit.author.login) {
      authors.add(commit.author.login);
    }
    // Also check committer in case author isn't set
    if (commit.committer && commit.committer.login && commit.committer.login !== 'web-flow') {
      authors.add(commit.committer.login);
    }
  }
  return [...authors];
}

async function setCommitStatus(octokit, owner, repo, sha, state, description) {
  await octokit.rest.repos.createCommitStatus({
    owner, repo, sha,
    state,          // 'success' | 'failure' | 'pending'
    description,
    context: STATUS_CONTEXT,
    target_url: CLA_DOC_URL,
  });
}

async function findExistingBotComment(octokit, owner, repo, prNumber) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  return comments.find(c =>
    c.user.type === 'Bot' &&
    c.body.includes('Contributor License Agreement')
  );
}

async function postOrUpdateComment(octokit, owner, repo, prNumber, body) {
  const existing = await findExistingBotComment(octokit, owner, repo, prNumber);
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner, repo, comment_id: existing.id, body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body,
    });
  }
}

function buildUnsignedComment(unsigned) {
  const userList = unsigned.map(u => `@${u}`).join(', ');
  return `## Contributor License Agreement

Thank you for your contribution! Before we can accept it, the following contributor(s) must sign our CLA:

**${userList}**

Please read the appropriate agreement:
- Contributing as an **individual**? Read the [Individual CLA](${INDIVIDUAL_CLA_URL})
- Contributing on behalf of a **company or organisation**? Read the [Entity CLA](${ENTITY_CLA_URL})

Once you have read the appropriate agreement, **post the following as a comment on this PR** (copy and paste exactly):

\`\`\`
${SIGN_PHRASE}
\`\`\`

The bot will record your signature and update this PR automatically.`;
}

function buildAllSignedComment() {
  return `## Contributor License Agreement ✅

All contributors have signed the CLA. Thank you!`;
}

async function checkAndUpdateCLA(octokit, patOctokit, owner, repo, prNumber, headSha, allowlist) {
  core.info(`Checking CLA for PR #${prNumber} in ${owner}/${repo}`);

  // Get all PR authors
  const authors = await getPRAuthors(octokit, owner, repo, prNumber);
  core.info(`PR authors: ${authors.join(', ')}`);

  // Filter out allowlisted users
  const relevant = authors.filter(a => !isAllowlisted(a, allowlist));
  core.info(`After allowlist filter: ${relevant.join(', ')}`);

  if (relevant.length === 0) {
    core.info('All authors are allowlisted, setting success');
    await setCommitStatus(octokit, owner, repo, headSha, 'success', 'All contributors are allowlisted');
    return;
  }

  // Load signatures
  const { data: sigData } = await loadSignatures(patOctokit);
  const signed = new Set(sigData.signedContributors.map(s => s.login.toLowerCase()));

  const unsigned = relevant.filter(a => !signed.has(a.toLowerCase()));
  core.info(`Unsigned: ${unsigned.join(', ')}`);

  if (unsigned.length === 0) {
    core.info('All contributors have signed');
    await setCommitStatus(octokit, owner, repo, headSha, 'success', 'All contributors have signed the CLA');
    await postOrUpdateComment(octokit, owner, repo, prNumber, buildAllSignedComment());
  } else {
    core.info(`Unsigned contributors: ${unsigned.join(', ')}`);
    await setCommitStatus(octokit, owner, repo, headSha, 'failure',
      `CLA not signed by: ${unsigned.join(', ')}`);
    await postOrUpdateComment(octokit, owner, repo, prNumber, buildUnsignedComment(unsigned));
  }
}

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    const pat = process.env.PERSONAL_ACCESS_TOKEN;

    if (!token) throw new Error('GITHUB_TOKEN is required');
    if (!pat) throw new Error('PERSONAL_ACCESS_TOKEN is required');

    const octokit = github.getOctokit(token);
    const patOctokit = github.getOctokit(pat);

    const allowlistInput = core.getInput('allowlist') || '';
    const allowlist = allowlistInput.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    core.info(`Allowlist: ${allowlist.join(', ')}`);

    const { eventName, payload } = github.context;
    core.info(`Event: ${eventName}`);

    if (eventName === 'issue_comment') {
      // Only handle comments on PRs
      if (!payload.issue.pull_request) {
        core.info('Comment is not on a PR, skipping');
        return;
      }

      const commentBody = payload.comment.body.trim();
      const commenter = payload.comment.user.login;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const prNumber = payload.issue.number;

      if (commentBody !== SIGN_PHRASE) {
        core.info(`Comment does not match sign phrase, skipping`);
        return;
      }

      core.info(`${commenter} is signing the CLA`);

      // Record signature
      const { data: sigData, sha } = await loadSignatures(patOctokit);
      const alreadySigned = sigData.signedContributors.some(
        s => s.login.toLowerCase() === commenter.toLowerCase()
      );

      if (!alreadySigned) {
        sigData.signedContributors.push({
          login: commenter,
          signed_at: new Date().toISOString(),
          pr_number: prNumber,
          repo: `${owner}/${repo}`,
        });
        await saveSignatures(patOctokit, sigData, sha);
        core.info(`Signature recorded for ${commenter}`);
      } else {
        core.info(`${commenter} has already signed`);
      }

      // Get the PR head SHA to update status
      const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      const headSha = pr.data.head.sha;

      await checkAndUpdateCLA(octokit, patOctokit, owner, repo, prNumber, headSha, allowlist);

    } else if (eventName === 'pull_request_target') {
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const prNumber = payload.pull_request.number;
      const headSha = payload.pull_request.head.sha;

      if (payload.action === 'closed') {
        core.info('PR closed, skipping');
        return;
      }

      await checkAndUpdateCLA(octokit, patOctokit, owner, repo, prNumber, headSha, allowlist);

    } else {
      core.info(`Unhandled event: ${eventName}`);
    }

  } catch (error) {
    core.setFailed(`CLA Action failed: ${error.message}`);
    console.error(error);
  }
}

run();
