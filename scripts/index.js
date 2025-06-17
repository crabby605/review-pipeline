import { Octokit } from '@octokit/core';
import { OpenAI } from 'openai';
import fs from 'node:fs/promises';
import https from 'https';

// Initialize API clients with authentication
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model   = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Parse GitHub event data to get PR information
const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH));
const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
const pr = event.pull_request.number;

// Fetch ALL the files changed in the PR with pagination
async function getAllPRFiles(owner, repo, pr) {
    let allFiles = [];
    let page = 1;
    let hasMoreFiles = true;
    
    console.log(`Fetching all files for PR #${pr}...`);
    
    while (hasMoreFiles) {
        const { data: files } = await octokit.request(
            'GET /repos/{owner}/{repo}/pulls/{pr}/files',
            { owner, repo, pr, per_page: 100, page }
        );
        
        allFiles = [...allFiles, ...files];
        console.log(`Fetched page ${page} with ${files.length} files. Total files so far: ${allFiles.length}`);
        
        if (files.length < 100) {
            hasMoreFiles = false;
        } else {
            page++;
        }
    }
    
    console.log(`Completed fetching all ${allFiles.length} files for PR #${pr}`);
    return allFiles;
}

// Get all files in the PR
const files = await getAllPRFiles(owner, repo, pr);

// Build the diff markdown and collect statistics
let diffMarkdown = '';
let linesAdded = 0, testsChanged = false, licenseComment = false;

// Process files in batches to avoid exceeding OpenAI token limits
const MAX_DIFF_LENGTH = 20000; // Characters limit for OpenAI
let batches = [];
let currentBatch = [];
let currentBatchSize = 0;

for (const f of files) {
    if (!f.patch) {
        console.log(`No patch available for ${f.filename}, skipping...`);
        continue;
    }
    
    // Check if this file would exceed the batch size
    if (currentBatchSize + f.patch.length > MAX_DIFF_LENGTH) {
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentBatchSize = 0;
        }
    }
    
    // Add file to current batch
    currentBatch.push(f);
    currentBatchSize += f.patch.length;
    
    // Update overall statistics
    linesAdded += f.additions;
    if (/test|spec/i.test(f.filename)) testsChanged = true;
    
    // check if license information is present in the diff
    if (/\+\s*(SPDX-License-Identifier|MIT License|Apache License)/.test(f.patch))
        licenseComment = true;
}

// Add the last batch if it has any files
if (currentBatch.length > 0) {
    batches.push(currentBatch);
}

console.log(`Split files into ${batches.length} batches for analysis`);

// Analyze each batch
let overallAiProb = 0;
let allRationales = [];

for (let i = 0; i < batches.length; i++) {
    console.log(`Analyzing batch ${i+1} of ${batches.length} (${batches[i].length} files)...`);
    
    // Create diff markdown for this batch
    let batchDiffMarkdown = '';
    for (const f of batches[i]) {
        batchDiffMarkdown += `\n\n### ${f.filename}\n\`\`\`diff\n${f.patch}\n\`\`\``;
    }
    
    // configure OpenAI request for AI detection with enhanced security focus
    const system = 'You are a security analyst detecting AI-generated code in pull requests for security reasons. ' +
        'Score from 0-1 where 1 means 100% confidence the code is AI-generated. ' +
        'Look for these telltale signs of AI generation: ' +
        '1. Unnaturally perfect grammar and formal language in comments - humans make mistakes and use informal language ' +
        '2. Excessive number of comments or overly detailed explanations that a human wouldn\'t typically write ' +
        '3. Presence of emojis in specific patterns or contexts that suggest template-like usage ' +
        '4. Verbose, descriptive variable/function names that are consistently perfect across the codebase ' +
        '5. Invisible watermarks or statistical patterns that AI models (especially newer ones) leave behind ' +
        '6. Code that is too "textbook perfect" with no quirks or idiosyncrasies that human coders typically have ' +
        '7. Consistent styling without natural human variations or inconsistencies ' +
        '8. Complete absence of typos, shorthand, or colloquialisms (humans aren\'t perfect) ' +
        '9. Overuse of design patterns or textbook implementations that look like they came from documentation ' +
        '10. Unusual consistency in comment style, indentation, and formatting beyond what tools would enforce ' +
        'Be particularly suspicious of perfect English throughout comments and documentation, as this rarely occurs in human-written code. ' +
        'Your analysis must include specific evidence from the code for any patterns detected. ' +
        'Return JSON via the tool.';
    const tool = {
        type: 'function',
        function: {
            name: 'report_ai_provenance',
            parameters: {
                type: 'object',
                properties: {
                    ai_prob: { type: 'number', description: '0–1 likelihood AI-generated' },
                    rationale: { type: 'string' }
                },
                required: ['ai_prob', 'rationale']
            }
        }
    };

    // send request to OpenAI to evaluate the diff
    const res = await openai.chat.completions.create({
        model,
        temperature: 0,
        tools: [tool],
        messages: [
            { role: 'system', content: system },
            { role: 'user',   content: batchDiffMarkdown }
        ]
    });

    // Extract the AI evaluation results
    const { ai_prob, rationale } = JSON.parse(
        res.choices[0].message.tool_calls[0].function.arguments
    );
    
    // Weight the AI probability by the number of files in the batch
    overallAiProb += ai_prob * (batches[i].length / files.length);
    allRationales.push(`Batch ${i+1}: ${rationale}`);
    
    console.log(`Batch ${i+1} AI probability: ${(ai_prob * 100).toFixed(1)}%`);
}

// Calculate overall score
const score = (overallAiProb * 100).toFixed(1);
const overallRationale = allRationales.join('\n\n');

// Load evaluation rules from text file
const rulesText = await fs.readFile('scripts/review.txt', 'utf8');
const rules = parseRulesFromText(rulesText);
let failures = [], warnings = [];

// apply each rule based on the context
for (const rule of rules) {
    const ctx = { 
        ai_prob: overallAiProb, 
        lines_added: linesAdded,
        tests_changed: testsChanged, 
        license_comment: licenseComment 
    };
    const triggered = eval(rule.when);
    if (triggered) {
        (rule.severity === 'error' ? failures : warnings).push(rule.message.trim());
    }
}

// format the review comment with more detailed analysis and UTC time
const body = `
### AI Code Review Report

| Metric | Value |
|--------|-------|
| Probability code is AI-generated | **${score}%** |
| Files analyzed | ${files.length} |
| Lines added | ${linesAdded} |
| Unit-tests changed | ${testsChanged ? 'Yes' : 'No'} |
| License comment present | ${licenseComment ? 'Yes' : 'No'} |
| Analysis time (UTC) | ${new Date().toISOString()} |

${failures.length ? '### ❌ FAILED' : '### ✅ PASSED'}

${failures.length ? '#### Policy Failures:' : ''}
${failures.map(m => `- ${m}`).join('\n')}

${warnings.length ? '#### Policy Warnings:' : ''}
${warnings.map(m => `- ${m}`).join('\n')}

### Analysis Summary
${overallRationale.slice(0, 3000)}${overallRationale.length > 3000 ? '... (truncated)' : ''}

---
*This review was automatically generated by the AI Code Review Pipeline.*
`;

// post the review to the PR
try {
  console.log(`Posting review comment to PR #${pr}...`);
  
  const { data: review } = await octokit.request(
      'POST /repos/{owner}/{repo}/pulls/{pr}/reviews',
      { owner, repo, pr, event: 'COMMENT', body }
  );
  
  console.log(`Review posted successfully: ${review.html_url}`);
} catch (error) {
  console.error(`Error posting review to PR: ${error.message}`);
}

// send notification to channel if score is over 55
if (parseFloat(score) > 55) {
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
    const slackMessage = JSON.stringify({
        text: `*AI Code Review Complete*\n*Repository:* \`${owner}/${repo}\`\n*Pull Request:* <https://github.com/${owner}/${repo}/pull/${pr}|#${pr}>\n*Score:* \`${score}%\`\n*Time (UTC):* \`${new Date().toISOString()}\`\n*Summary:* \`${overallRationale.slice(0, 500)}...\`\n\n🔗 <https://github.com/${owner}/${repo}/pull/${pr}|View PR>`
    });
    
    const url = new URL(slackWebhookUrl);
    const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(slackMessage)
        }
    };
    
    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            if (res.statusCode >= 400) {
                console.error(`Error sending to Slack: ${res.statusCode} ${data}`);
            }
        });
    });
    
    req.on('error', (e) => {
        console.error(`Error sending to Slack: ${e.message}`);
    });
    
    req.write(slackMessage);
    req.end();
}

// Function to parse rules from text file
function parseRulesFromText(text) {
    const rules = [];
    const sections = text.split('[rule]').slice(1);
    
    for (const section of sections) {
        const rule = {};
        const lines = section.trim().split('\n');
        
        for (const line of lines) {
            if (line.trim() && !line.startsWith('#')) {
                const [key, ...valueParts] = line.split('=');
                const value = valueParts.join('=').trim();
                rule[key.trim()] = value;
            }
        }
        
        if (rule.name && rule.when && rule.severity && rule.message) {
            rules.push(rule);
        }
    }
    
    return rules;
}

// exit with error code if any failures were found
if (failures.length) process.exit(1);