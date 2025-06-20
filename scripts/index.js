import { Octokit } from '@octokit/core';
import { createAppAuth } from '@octokit/auth-app';
import { OpenAI } from 'openai';
import fs from 'node:fs/promises';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration (environment variables)
const CONFIG = {
  githubAppId: process.env.GITHUB_APP_ID,
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  maxBatchSize: 1200000,      // ~1.2MB of code per batch to avoid truncation
  maxFilesPerBatch: 15,       // Files per batch for better analysis
  excludedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg', 
                      '.ttf', '.woff', '.woff2', '.eot', '.mp3', '.mp4', 
                      '.webm', '.ogg', '.wav', '.avi', '.mov', '.webp',
                      '.zip', '.rar', '.tar', '.gz', '.7z', '.exe', '.dll', 
                      '.so', '.dylib', '.obj', '.lib', '.bin', '.apk', '.aab', '.ipa'],
  excludedFiles: ['LICENSE', 'LICENSE.md', 'LICENSE.txt'],
  excludedDirs: ['node_modules', '.git'],
  thresholds: {
    aiGenerated: 80,      // Score >= 80% is considered fully AI-generated
    aiAssisted: 50        // Score between 50% and 80% is considered highly AI-assisted
  }
};

// Initialize Octokit with GitHub App authentication
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: CONFIG.githubAppId,
    privateKey: CONFIG.githubAppPrivateKey,
    installationId: CONFIG.githubAppInstallationId
  }
});

// Initialize OpenAI
const openai = new OpenAI({ apiKey: CONFIG.openaiApiKey });

/**
 * Main function to analyze a pull request
 */
async function analyzePullRequest() {
  // Initialize report data
  const reportData = initializeReportData();
  let tokenCount = 0;
  const startTime = Date.now();

  try {
    console.log('GitHub App Authentication: Initializing with App ID:', CONFIG.githubAppId);
    
    // Parse GitHub event data to get PR information
    const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH));
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const pr = event.pull_request.number;
    
    console.log(`Analyzing PR #${pr} in ${owner}/${repo}`);
    
    reportData.repository = `${owner}/${repo}`;
    reportData.pr_number = pr;
    reportData.pr_title = event.pull_request.title;
    reportData.pr_url = event.pull_request.html_url;
    
    // Get all files in the PR
    console.log('Fetching all files in the PR...');
    const files = await getAllPRFiles(owner, repo, pr);
    reportData.files_total = files.length;
    console.log(`Found ${files.length} files in the PR`);
    
    // Filter out excluded files
    const codeFiles = filterCodeFiles(files);
    reportData.files_filtered = codeFiles.length;
    console.log(`After filtering, ${codeFiles.length} files will be analyzed`);
    
    if (codeFiles.length === 0) {
      console.log('No code files to analyze after filtering');
      reportData.analysis_status = 'skipped';
      reportData.error = 'No code files to analyze after filtering';
      return;
    }
    
    // Calculate total size of all code files for token estimation
    const totalCodeSize = codeFiles.reduce((sum, file) => sum + (file.patch ? file.patch.length : 0), 0);
    const estimatedTokens = Math.ceil(totalCodeSize / 4); // Rough estimate: ~4 chars per token
    reportData.estimated_tokens = estimatedTokens;
    
    console.log(`Total code size: ${totalCodeSize} characters`);
    console.log(`Estimated tokens for analysis: ~${estimatedTokens} tokens`);
    
    // Organize files into batches and collect statistics
    const { batches, stats } = organizeFilesIntoBatches(codeFiles);
    
    // Update report with statistics
    reportData.total_lines = stats.linesAdded;
    reportData.license_detected = stats.licenseComment;
    reportData.tests_found = stats.testsChanged;
    
    // Analyze each batch
    let overallAiProb = 0;
    let allPatterns = [];
    let allRationales = [];
    let overallCodeQuality = 'Unknown';
    let batchSizes = [];
    let batchTokens = [];
    
    for (let i = 0; i < batches.length; i++) {
      const batchSize = batches[i].reduce((sum, file) => sum + (file.patch ? file.patch.length : 0), 0);
      const batchTokenEstimate = Math.ceil(batchSize / 4);
      batchSizes.push(batchSize);
      batchTokens.push(batchTokenEstimate);
      
      console.log(`\nAnalyzing batch ${i+1} of ${batches.length}:`);
      console.log(`   Files: ${batches[i].length}`);
      console.log(`   Size: ${(batchSize / 1024).toFixed(2)} KB`);
      console.log(`   Estimated tokens: ~${batchTokenEstimate}`);
      
      try {
        const { ai_prob, patterns_detected, code_quality, rationale, tokens_used } = await analyzeFileBatch(batches[i], i);
        
        // Track token usage
        tokenCount += tokens_used || batchTokenEstimate;
        
        // Weight the AI probability by the number of files in the batch
        overallAiProb += ai_prob * (batches[i].length / codeFiles.length);
        
        // Add unique patterns
        patterns_detected.forEach(pattern => {
          if (!allPatterns.includes(pattern)) {
            allPatterns.push(pattern);
          }
        });
        
        // Accumulate rationales
        allRationales.push(`Batch ${i+1} (${batches[i].length} files): ${rationale}`);
        
        // Determine overall code quality
        updateOverallCodeQuality(i, code_quality);
        
        console.log(`   Batch ${i+1} AI probability: ${ai_prob.toFixed(1)}%`);
        console.log(`   Batch ${i+1} code quality: ${code_quality}`);
        console.log(`   Batch ${i+1} patterns: ${patterns_detected.length}`);
        console.log(`   Tokens used: ~${tokens_used || 'Unknown'}`);
      } catch (error) {
        console.error(`   Error analyzing batch ${i+1}: ${error.message}`);
        allRationales.push(`Batch ${i+1}: Error during analysis - ${error.message}`);
      }
    }
    
    // Calculate analysis duration
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    reportData.analysis_duration = `${duration} seconds`;
    reportData.token_usage = tokenCount;
    
    // Calculate final score and update report
    const score = overallAiProb.toFixed(1);
    reportData.ai_probability = parseFloat(score);
    reportData.code_quality = overallCodeQuality;
    reportData.patterns_detected = allPatterns;
    reportData.rationale = allRationales.join('\n\n');
    
    console.log(`\nOverall AI Analysis Results:`);
    console.log(`   AI probability score: ${score}%`);
    console.log(`   Code quality: ${overallCodeQuality}`);
    console.log(`   Patterns detected: ${allPatterns.length}`);
    console.log(`   Analysis duration: ${duration} seconds`);
    console.log(`   Estimated token usage: ~${tokenCount}`);
    
    // Apply evaluation rules and determine AI status
    const { failures, warnings, aiStatus } = evaluateAgainstPolicyRules(reportData);
    reportData.failures = failures;
    reportData.warnings = warnings;
    reportData.ai_status = aiStatus;
    
    // Post the review to the PR
    await postReviewToPR(owner, repo, pr, formatReviewComment(reportData));
    
    // Send notification to Slack if score is over threshold or always if enabled
    await sendSlackNotification(reportData);
    
    // Mark analysis as complete
    reportData.analysis_status = 'completed';
    
  } catch (error) {
    console.error(`Error in analysis process: ${error.message}`);
    console.error(error.stack);
    reportData.analysis_status = 'failed';
    reportData.error = error.message;
    
    // Try to send error notification to Slack
    try {
      await sendSlackNotification(reportData);
    } catch (slackError) {
      console.error(`Failed to send error notification to Slack: ${slackError.message}`);
    }
  }
  
  // Function to update overall code quality
  function updateOverallCodeQuality(batchIndex, batchQuality) {
    if (batchIndex === 0 || overallCodeQuality === 'Unknown') {
      overallCodeQuality = batchQuality;
    } else {
      // Quality precedence: poor < average < good < excellent
      const qualityRank = {
        'poor': 0,
        'average': 1,
        'good': 2,
        'excellent': 3
      };
      
      // Take the lower quality between current overall and this batch
      const currentRank = qualityRank[overallCodeQuality] || 0;
      const batchRank = qualityRank[batchQuality] || 0;
      
      if (batchRank < currentRank) {
        overallCodeQuality = batchQuality;
      }
    }
  }
}

// ... rest of the existing code ...

/**
 * Analyzes a batch of files for AI-generated content
 * @param {Array} batch - Array of files to analyze
 * @param {number} batchIndex - Index of the current batch
 * @returns {Promise<Object>} - Analysis results
 */
async function analyzeFileBatch(batch, batchIndex) {
  // Create diff markdown for this batch
  let batchDiffMarkdown = '';
  for (const file of batch) {
    batchDiffMarkdown += `\n\n### ${file.filename}\n\`\`\`diff\n${file.patch}\n\`\`\``;
  }
  
  // Estimate token count for this batch
  const estimatedTokens = Math.ceil(batchDiffMarkdown.length / 4);
  
  // Configure OpenAI request for AI detection
  const system = 'You are an analyst detecting AI-generated code in pull requests for security reasons. ' +
    'Score from 0-100 where 100 means 100% confidence the code is AI-generated. ' +
    'Carefully analyze the code for these telltale signs of AI generation: ' +
    '1. Perfect grammar and formal language in comments - real developers make typos, use abbreviations, and write informally ' +
    '2. Quality of comments - focus more on the quality rather than quantity; AI tends to provide unnecessarily verbose explanations ' +
    '3. Emoji usage - certain patterns of emoji usage can indicate AI generation ' +
    '4. Verbose, "perfect" variable/function naming - AI often creates unnaturally descriptive and consistent names ' +
    '5. Invisible watermarks - check for statistical patterns or markers that AI models embed in generated text ' +
    '6. Perfect English throughout - this is virtually impossible in real human code; look for natural language variations ' +
    'Pay special attention to grammar and writing style in comments as key indicators of AI generation. ' +
    'Return a JSON object with: ai_prob (0-100), patterns_detected (array), code_quality (string), rationale (string).';

  const tool = {
    type: 'function',
    function: {
      name: 'report_ai_code_analysis',
      parameters: {
        type: 'object',
        properties: {
          ai_prob: { 
            type: 'number', 
            description: '0–100 likelihood AI-generated'
          },
          patterns_detected: {
            type: 'array',
            description: 'Specific patterns indicating AI generation',
            items: {
              type: 'string'
            }
          },
          code_quality: {
            type: 'string',
            description: 'Assessment of code quality (poor, average, good, excellent)'
          },
          rationale: { 
            type: 'string',
            description: 'Detailed explanation of the analysis'
          }
        },
        required: ['ai_prob', 'patterns_detected', 'code_quality', 'rationale']
      }
    }
  };
  
  // Send request to OpenAI
  const res = await openai.chat.completions.create({
    model: CONFIG.openaiModel,
    temperature: 0,
    tools: [tool],
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: batchDiffMarkdown }
    ]
  });
  
  // Get actual token usage
  const tokensUsed = res.usage?.total_tokens || estimatedTokens;
  
  // Parse and return results
  const result = JSON.parse(res.choices[0].message.tool_calls[0].function.arguments);
  result.tokens_used = tokensUsed;
  
  return result;
}

// ... rest of the existing code ...

/**
 * Formats the review comment
 * @param {Object} reportData - Report data
 * @returns {string} - Formatted comment
 */
function formatReviewComment(reportData) {
  // Determine AI status label
  let aiStatusLabel = 'Likely Human-Written';
  if (reportData.ai_status === 'ai_generated') {
    aiStatusLabel = '⚠️ Fully AI-Generated';
  } else if (reportData.ai_status === 'ai_assisted') {
    aiStatusLabel = '⚠️ Highly AI-Assisted';
  }
  
  // Format patterns detected
  const formattedPatterns = reportData.patterns_detected && reportData.patterns_detected.length > 0
    ? reportData.patterns_detected.map(pattern => `- ${pattern}`).join('\n')
    : 'None detected';
    
  // Format failures and warnings
  const failuresText = reportData.failures && reportData.failures.length > 0
    ? reportData.failures.map(f => `- ${f}`).join('\n')
    : 'None';
    
  const warningsText = reportData.warnings && reportData.warnings.length > 0
    ? reportData.warnings.map(w => `- ${w}`).join('\n')
    : 'None';
  
  return `
## AI Code Review Report

| Metric | Value |
|--------|-------|
| AI Probability | **${reportData.ai_probability}%** |
| Assessment | **${aiStatusLabel}** |
| Files Analyzed | ${reportData.files_filtered} of ${reportData.files_total} |
| Lines Added | ${reportData.total_lines} |
| Unit Tests Modified | ${reportData.tests_found ? 'Yes' : 'No'} |
| License Comment Present | ${reportData.license_detected ? 'Yes' : 'No'} |
| Code Quality | ${reportData.code_quality || 'Unknown'} |
| Analysis Time (UTC) | ${reportData.analysis_date} |
| Analysis Duration | ${reportData.analysis_duration || 'Unknown'} |
| Estimated Token Usage | ${reportData.token_usage || 'Unknown'} |

### AI Detection Patterns
${formattedPatterns}

${reportData.failures.length ? '### ❌ Policy Failures' : ''}
${failuresText !== 'None' ? failuresText : ''}

${reportData.warnings.length ? '### ⚠️ Policy Warnings' : ''}
${warningsText !== 'None' ? warningsText : ''}

### Analysis Summary
${reportData.rationale || 'No summary available'}

---
*This review was automatically generated by the AI Code Review Pipeline.*
`;
}

// ... rest of the existing code ...

// Run the analysis
analyzePullRequest();
