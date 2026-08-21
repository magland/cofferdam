import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUpstream } from '../src/source';

test('parseUpstream accepts the two URL shapes a fork clones from', () => {
  const https = parseUpstream('https://github.com/octocat/Hello-World.git');
  assert.ok(https);
  assert.equal(https.label, 'github.com/octocat/Hello-World');
  assert.equal(https.web, 'https://github.com/octocat/Hello-World');
  assert.deepEqual(https.github, { owner: 'octocat', repo: 'Hello-World' });

  const bare = parseUpstream('https://github.com/octocat/Hello-World');
  assert.ok(bare);
  assert.equal(bare.web, 'https://github.com/octocat/Hello-World');

  const ssh = parseUpstream('git@github.com:octocat/Hello-World.git');
  assert.ok(ssh);
  assert.equal(ssh.label, 'github.com/octocat/Hello-World');
  assert.equal(ssh.web, 'https://github.com/octocat/Hello-World');
  assert.deepEqual(ssh.github, { owner: 'octocat', repo: 'Hello-World' });
});

test('parseUpstream knows a non-GitHub host has no pull requests to send', () => {
  const other = parseUpstream('https://gitlab.example.com/group/project.git');
  assert.ok(other);
  assert.equal(other.label, 'gitlab.example.com/group/project');
  assert.equal(other.web, 'https://gitlab.example.com/group/project');
  assert.equal(other.github, null);

  const sshOther = parseUpstream('git@gitlab.example.com:group/project.git');
  assert.ok(sshOther);
  assert.equal(sshOther.web, null);
});

test('parseUpstream refuses what git clone should never be handed back', () => {
  assert.equal(parseUpstream(''), null);
  assert.equal(parseUpstream('/home/alice/project'), null);
  assert.equal(parseUpstream('http://github.com/octocat/Hello-World'), null);
  assert.equal(parseUpstream('https://github.com/octocat/Hello World'), null);
  assert.equal(parseUpstream('owner/repo'), null);
});
