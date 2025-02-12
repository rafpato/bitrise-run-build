/* eslint-disable @typescript-eslint/no-explicit-any */
// https://github.com/bitrise-io/bitrise-webhooks/blob/c2eb7226bc838ad36c27cdcba63eaf91b3e791d0/service/hook/github/github.go

import * as core from '@actions/core'
import * as github from '@actions/github'
import type {
  BitriseEnvironment,
  BitriseBuildOptions,
  CommitPathsFilter,
  BitriseAppDetails
} from './types'
import { urlsReferTheSameGitHubRepo } from '../utils'

export function createBuildOptions(
  appDetails: BitriseAppDetails | null
): BitriseBuildOptions {
  const workflow = core.getInput('bitrise-workflow', { required: false })
  const pipeline = core.getInput('bitrise-pipeline', { required: false })
  const listen = core.getBooleanInput('listen', { required: false })

  if (!workflow && !pipeline) {
    core.setFailed(
      'Either bitrise-workflow or bitrise-pipeline must be provided'
    )
    return {}
  }

  if (workflow && pipeline) {
    core.setFailed('Cannot specify both bitrise-workflow and bitrise-pipeline')
    return {}
  }

  if (pipeline && listen) {
    core.setFailed('Listen option is not supported with bitrise-pipeline')
    return {}
  }

  core.info(`Process "${github.context.eventName}" event`)

  let defaultBranchOptions: Record<string, any> | null = null
  let options: Record<string, any>
  const environments: BitriseEnvironment[] = prepareEnvironmentVariables()

  if (github.context.payload) {
    defaultBranchOptions = transformBasicEvent(github.context.payload)
  }

  const branchOverride = core.getInput('branch-override', { required: false })
  const commitOverride = core.getInput('commit-override', { required: false })
  if (branchOverride || commitOverride) {
    options = processOverrides(
      appDetails,
      defaultBranchOptions,
      branchOverride,
      commitOverride
    )
  } else if (github.context.payload?.pull_request) {
    options = transformPullRequestEvent(github.context.payload.pull_request)
    if (github.context.payload.pull_request.draft) {
      environments.push({
        mapped_to: 'GITHUB_PR_IS_DRAFT',
        value: 'true',
        is_expand: false
      })
    }
  } else {
    if (!defaultBranchOptions) {
      core.setFailed('No payload found in the context.')
      return {}
    }
    options = defaultBranchOptions
  }

  const skipGitStatusReport = core.getBooleanInput('skip-git-status-report', {
    required: false
  })

  if (
    appDetails?.repo_url &&
    !urlsReferTheSameGitHubRepo(
      appDetails.repo_url,
      options.base_repository_url
    )
  ) {
    core.warning(
      `Bitrise App's repository url "${appDetails.repo_url}" doesn't match current repository url "${options.base_repository_url}"`
    )
  }

  core.info(
    `Following source options will be sent to Bitrise: ${JSON.stringify(options, null, 2)}`
  )

  return {
    ...options,
    workflow_id: workflow || undefined,
    pipeline_id: pipeline || undefined,
    skip_git_status_report: skipGitStatusReport,
    environments
  }
}

function transformBasicEvent(payload: Record<string, any>) {
  if (payload.deleted) {
    core.setFailed("this is a 'Deleted' event, no build can be started")
    return {}
  }
  let options: Record<string, any> = {}
  const commits =
    payload.commits ?? (payload.head_commit ? [payload.head_commit] : [])
  const commitPaths: CommitPathsFilter[] = []
  const commitMessages: string[] = []

  const ref = github.context.ref
  if (ref.startsWith('refs/heads/')) {
    for (const commit of commits) {
      commitMessages.push(commit.message)
      commitPaths.push({
        added: commit.added,
        removed: commit.removed,
        modified: commit.modified
      })
    }
    options = {
      branch: ref.slice(11)
    }
  } else if (ref.startsWith('refs/tags/')) {
    options = {
      tag: ref.slice(10)
    }
  }
  return {
    ...options,
    commit_hash: github.context.sha,
    commit_message: payload.head_commit?.message,
    commit_messages: commitMessages,
    commit_paths: commitPaths,
    base_repository_url: getRepositoryURL(payload.repository)
  }
}

function transformPullRequestEvent(pr: Record<string, any>) {
  const options: Record<string, string> = {}
  const prNumber = pr.number

  options.pull_request_unverified_merge_branch = `pull/${prNumber}/merge`

  const mergeable: boolean | null = pr.mergeable
  // If `mergeable` is null, the merge ref is not up-to-date, it's not safe to use for checkouts.
  const mergeRefUpToDate = mergeable != null
  if (mergeRefUpToDate) {
    options.pull_request_merge_branch =
      options.pull_request_unverified_merge_branch
  }
  if (mergeRefUpToDate && mergeable === false) {
    core.setFailed('Pull Request is not mergeable')
    return {}
  }

  let commitMsg = pr.title
  if (pr.body) {
    commitMsg += `\n\n${pr.body}`
  }

  return {
    ...options,
    commit_hash: pr.head?.sha,
    commit_message: commitMsg,
    branch: pr.head?.ref,
    branch_repo_owner: pr.head?.repo?.owner?.login,
    branch_dest: pr.base?.ref,
    branch_dest_repo_owner: pr.base?.repo?.owner?.login,
    pull_request_id: prNumber,
    head_repository_url: getRepositoryURL(pr.head?.repo),
    pull_request_repository_url: getRepositoryURL(pr.head?.repo),
    base_repository_url: getRepositoryURL(pr.base?.repo),
    pull_request_head_branch: `pull/${prNumber}/head`,
    pull_request_author: pr.user?.login,
    diff_url: pr.diff_url,
    pull_request_ready_state: getPrReadyState(pr)
  }
}

function processOverrides(
  appDetails: BitriseAppDetails | null,
  defaultBranchOptions: Record<string, any> | null,
  branchOverride: string,
  commitOverride: string
) {
  if (!appDetails) {
    core.warning(
      'It is recommended to use "bitrise-token" with overrides options.'
    )
  }
  let branchOptions: Record<string, any> = {}
  if (appDetails?.repo_url) {
    branchOptions = {
      base_repository_url: appDetails.repo_url
    }
  }
  if (branchOverride.startsWith('refs/heads/')) {
    branchOptions = {
      ...branchOptions,
      branch: branchOverride.slice(11)
    }
  } else if (branchOverride.startsWith('refs/tags/')) {
    branchOptions = {
      ...branchOptions,
      tag: branchOverride.slice(10)
    }
  } else if (branchOverride) {
    branchOptions = {
      ...branchOptions,
      branch: branchOverride
    }
  }
  if (
    branchOverride &&
    ((branchOptions.branch &&
      branchOptions.branch === defaultBranchOptions?.branch) ||
      (branchOptions.tag && branchOptions.tag === defaultBranchOptions?.tag))
  ) {
    if (
      appDetails?.repo_url &&
      urlsReferTheSameGitHubRepo(
        appDetails.repo_url,
        defaultBranchOptions?.base_repository_url
      )
    ) {
      // if branchOverride matches branch for push event and repository is the same,
      // just use the default options
      branchOptions = {
        ...branchOptions,
        ...defaultBranchOptions
      }
    }
  }
  if (commitOverride && commitOverride !== defaultBranchOptions?.commit_hash) {
    branchOptions = {
      branch: branchOptions.branch,
      tag: branchOptions.tag,
      commit_hash: commitOverride,
      base_repository_url: branchOptions.base_repository_url
    }
  }
  return branchOptions
}

function getRepositoryURL(
  repoInfoModel?: Record<string, string>
): string | undefined {
  if (repoInfoModel?.private) {
    return repoInfoModel.ssh_url
  }
  return repoInfoModel?.clone_url
}

function getPrReadyState(pr: Record<string, any>) {
  if (pr.action === 'ready_for_review') {
    return 'converted_to_ready_for_review'
  }
  if (pr.draft) {
    return 'draft'
  }
  return 'ready_for_review'
}

function prepareEnvironmentVariables() {
  const envPassThrough = core
    .getInput('env-vars-for-bitrise', { required: false })
    .split(',')
    .map(i => i.trim())
    .filter(i => i !== '')

  return Object.entries(process.env)
    .filter(([key]) => envPassThrough.includes(key))
    .map<BitriseEnvironment>(([mapped_to, value = '']) => ({
      mapped_to,
      value,
      is_expand: false
    }))
}

export function getActorUsername(): string {
  switch (github.context.eventName) {
    case 'pull_request':
      return github.context.payload.sender?.login ?? github.context.actor
    case 'push':
      return github.context.payload.pusher?.name ?? github.context.actor
  }
  return github.context.actor
}
