import { Octokit } from '@octokit/core';
import { OpenAI } from 'openai';
import fs from 'node:fs/promises';
import https from 'https';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Fix for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);


// Initialize API clients with authentication
const octokit = new Octokit({ auth: githubToken });
const openai = new OpenAI({ apiKey: openaiApiKey });
const model = openaiModel;

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to send message to Slack
function sendToSlack(message) {
  return new Promise((resolve, reject) => {
    try {
      console.log(`\nSending report to Slack...`);
      
      const slackMessage = JSON.stringify(message);
      
      // Parse the webhook URL to get host and path
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
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`\nSuccessfully sent to Slack`);
            resolve();
          } else {
            console.log(`\nSlack API responded with status code ${res.statusCode}: ${responseData}`);
            resolve(); // Still resolve to continue program execution
          }
        });
      });
      
      req.on('error', (error) => {
        console.error(`\nError sending to Slack: ${error.message}`);
        resolve(); // Still resolve to continue program execution
      });
      
      req.write(slackMessage);
      req.end();
    } catch (error) {
      console.error(`\nError preparing Slack message: ${error.message}`);
      resolve(); // Still resolve to continue program execution
    }
  });
}

// Function to get all tree items (files) recursively with pagination and directory traversal
async function getAllTreeItems(owner, repo, branch) {
  let allItems = [];
  let directoriesToProcess = [];
  
  try {
    // Get the root tree first
    console.log(`Fetching repository root tree...`);
    const { data: rootTree } = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{branch}', {
      owner,
      repo,
      branch
    });
    
    // Add root items to our collection
    allItems = [...rootTree.tree];
    
    // Collect directories for further processing
    directoriesToProcess = rootTree.tree
      .filter(item => item.type === 'tree')
      .map(dir => dir.path);
    
    console.log(`Found ${allItems.length} items at root level, ${directoriesToProcess.length} directories to process`);
    
    // Process each directory recursively
    let processedDirs = 0;
    while (directoriesToProcess.length > 0) {
      const dirPath = directoriesToProcess.shift();
      processedDirs++;
      
      if (processedDirs % 10 === 0) {
        console.log(`Processed ${processedDirs} directories, ${directoriesToProcess.length} remaining...`);
      }
      
      try {
        const { data: dirTree } = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{sha}', {
          owner,
          repo,
          sha: allItems.find(item => item.path === dirPath).sha
        });
        
        // Add path prefix to all items in this directory
        const dirItems = dirTree.tree.map(item => ({
          ...item,
          path: `${dirPath}/${item.path}`
        }));
        
        // Add items to our collection
        allItems = [...allItems, ...dirItems];
        
        // Add new directories to process
        const newDirs = dirItems
          .filter(item => item.type === 'tree')
          .map(dir => dir.path);
        
        directoriesToProcess = [...directoriesToProcess, ...newDirs];
      } catch (dirError) {
        console.log(`Error fetching directory ${dirPath}: ${dirError.message}`);
      }
    }
    
    console.log(`Completed recursive tree traversal, found ${allItems.length} total items`);
  } catch (error) {
    console.error(`\nError fetching repository tree: ${error.message}`);
    // Try an alternative approach using the contents API
    try {
      console.log(`Falling back to contents API for repository traversal...`);
      allItems = await getAllItemsUsingContentsAPI(owner, repo);
    } catch (fallbackError) {
      console.error(`\nFallback approach also failed: ${fallbackError.message}`);
    }
  }
  
  return allItems;
}

// Helper function to recursively fetch repository contents using the contents API
async function getAllItemsUsingContentsAPI(owner, repo, path = '') {
  let allItems = [];
  
  try {
    const { data: contents } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path
    });
    
    const items = Array.isArray(contents) ? contents : [contents];
    
    // Convert contents format to tree format
    const treeItems = items.map(item => ({
      path: item.path,
      type: item.type === 'dir' ? 'tree' : 'blob',
      sha: item.sha,
      url: item.url
    }));
    
    allItems = [...treeItems];
    
    // Recursively process directories
    for (const item of treeItems) {
      if (item.type === 'tree') {
        const dirItems = await getAllItemsUsingContentsAPI(owner, repo, item.path);
        allItems = [...allItems, ...dirItems];
      }
    }
  } catch (error) {
    console.error(`Error fetching contents for ${path || 'root'}: ${error.message}`);
  }
  
  return allItems;
}

// Function to analyze code in batches with improved batch handling
async function analyzeCodeBatches(codeFiles, owner, repo, reportData) {
  const MAX_BATCH_SIZE = 800000; // ~800KB of code per batch to stay within token limits
  const MAX_FILES_PER_BATCH = 25; // Reduced for better analysis quality per batch
  
  let batches = [];
  let currentBatch = [];
  let currentBatchSize = 0;
  let totalFiles = 0;
  let totalLines = 0;
  let licenseDetected = false;
  let testFilesFound = false;
  
  // Track which files we were able to analyze
  reportData.analyzed_files = [];
  
  // Progress tracking
  let processedCount = 0;
  const totalCount = codeFiles.length;
  
  // First, fetch all files and organize them into batches
  for (const file of codeFiles) {
    processedCount++;
    if (processedCount % 50 === 0 || processedCount === totalCount) {
      console.log(`Processing files: ${processedCount}/${totalCount} (${Math.round(processedCount/totalCount*100)}%)`);
    }
    
    try {
      const { data: fileContent } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: file.path
      });
      
      if (fileContent.encoding === 'base64') {
        const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
        const lines = content.split('\n');
        totalLines += lines.length;
        totalFiles++;
        
        // Check for license comment or file
        if (/SPDX-License-Identifier|MIT License|Apache License/.test(content)) {
          licenseDetected = true;
        }
        
        // Check for test files
        if (/test|spec/i.test(file.path)) {
          testFilesFound = true;
        }
        
        // Create file entry for the report
        const fileEntry = {
          path: file.path,
          lines: lines.length
        };
        
        reportData.analyzed_files.push(fileEntry);
        
        // Check if adding this file would exceed batch limits
        if (currentBatchSize + content.length > MAX_BATCH_SIZE || currentBatch.length >= MAX_FILES_PER_BATCH) {
          if (currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentBatchSize = 0;
          }
        }
        
        // Add file to current batch
        const truncatedContent = content.length > 12000 
          ? content.slice(0, 12000) + "\n... (content truncated for analysis)"
          : content;
          
        currentBatch.push({
          path: file.path,
          content: truncatedContent
        });
        currentBatchSize += truncatedContent.length;
      }
    } catch (err) {
      console.log(`   Error fetching ${file.path}: ${err.message}`);
      reportData.analyzed_files.push({
        path: file.path,
        error: err.message
      });
    }
  }
  
  // Add the last batch if it has any files
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  reportData.total_files = totalFiles;
  reportData.total_lines = totalLines;
  reportData.license_detected = licenseDetected;
  reportData.tests_found = testFilesFound;
  
  console.log(`\nAnalysis statistics:`);
  console.log(`   Total files analyzed: ${totalFiles}`);
  console.log(`   Total lines analyzed: ${totalLines}`);
  console.log(`   License detected: ${licenseDetected ? 'Yes' : 'No'}`);
  console.log(`   Test files found: ${testFilesFound ? 'Yes' : 'No'}`);
  console.log(`   Batches to analyze: ${batches.length}`);
  
  // Now analyze each batch
  let allPatterns = [];
  let overallAiProb = 0;
  let overallCodeQuality = 'Unknown';
  let allRationales = [];
  
  for (let i = 0; i < batches.length; i++) {
    console.log(`\nAnalyzing batch ${i+1} of ${batches.length} (${batches[i].length} files)...`);
    
    // Create markdown for the batch
    let batchMarkdown = '';
    for (const file of batches[i]) {
      batchMarkdown += `\n\n### ${file.path}\n\`\`\`\n${file.content}\n...\n\`\`\``;
    }
    
    // Configure OpenAI request for AI detection with enhanced security focus
    const system = 'You are a security analyst detecting AI-generated code in repositories for security reasons. ' +
      'Score from 0-1 where 1 means 100% confidence the code is AI-generated (convert to a score out of 100 in your rationale). ' +
      'Carefully analyze the code for  these telltale signs of AI generation: ' +
      '1. Perfect grammar and formal language in comments - real developers make typos, use abbreviations, and write informally ' +
      '2. Quantity of comments - AI tends to over-comment or provide explanations that are unnecessarily verbose ' +
      '3. Emoji usage - certain patterns of emoji usage can indicate AI generation ' +
      '4. Verbose, "perfect" variable/function naming - AI often creates unnaturally descriptive and consistent names ' +
      '5. Invisible watermarks - check for statistical patterns or markers that AI models embed in generated text ' +
      '6. Perfect English throughout - this is virtually impossible in real human code; look for natural language variations ' +
      '7. Unnatural consistency in style - humans show variations in their coding patterns even within the same file ' +
      '8. Documentation that reads like it was written for a general audience rather than for developers ' +
      '9. Lack of domain-specific shortcuts, idioms, or "clever" solutions that experienced developers typically use ' +
      '10. Code organization that appears too methodical, as if following a rigid template ' +
      'Human code typically contains: inconsistent naming conventions, sporadic comments focused on complex parts, ' +
      'occasional typos, varying levels of documentation quality, and idiosyncratic coding patterns. ' +
      'Note that some AI-generated code now intentionally introduces "fake mistakes" to appear human, but these often ' +
      'follow detectable patterns themselves. Provide detailed evidence for your conclusions. Return JSON via the tool.';
    
    const tool = {
      type: 'function',
      function: {
        name: 'report_ai_code_analysis',
        parameters: {
          type: 'object',
          properties: {
            ai_prob: { 
              type: 'number', 
              description: '0–1 likelihood AI-generated'
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
    
    try {
      // Send request to OpenAI to evaluate the code
      const res = await openai.chat.completions.create({
        model,
        temperature: 0,
        tools: [tool],
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: batchMarkdown }
        ]
      });
      
      // Extract the AI evaluation results
      const aiAnalysis = JSON.parse(
        res.choices[0].message.tool_calls[0].function.arguments
      );
      
      const { ai_prob, patterns_detected, code_quality, rationale } = aiAnalysis;
      
      // Accumulate results
      overallAiProb += ai_prob * (batches[i].length / totalFiles); // Weighted average
      
      // Add unique patterns
      for (const pattern of patterns_detected) {
        if (!allPatterns.some(p => p === pattern)) {
          allPatterns.push(pattern);
        }
      }
      
      // Accumulate rationales
      allRationales.push(`Batch ${i+1} (${batches[i].length} files): ${rationale}`);
      
      // Determine overall code quality (simple logic, can be improved)
      if (i === 0 || overallCodeQuality === 'Unknown') {
        overallCodeQuality = code_quality;
      } else if (
        (code_quality === 'poor' && overallCodeQuality !== 'poor') ||
        (code_quality === 'average' && overallCodeQuality === 'good' || overallCodeQuality === 'excellent') ||
        (code_quality === 'good' && overallCodeQuality === 'excellent')
      ) {
        // Downgrade if a batch has lower quality
        overallCodeQuality = code_quality;
      }
      
      console.log(`   Batch ${i+1} AI probability: ${(ai_prob * 100).toFixed(1)}%`);
      console.log(`   Batch ${i+1} code quality: ${code_quality}`);
      console.log(`   Batch ${i+1} patterns: ${patterns_detected.length}`);
    } catch (error) {
      console.error(`   Error analyzing batch ${i+1}: ${error.message}`);
      allRationales.push(`Batch ${i+1}: Error during analysis - ${error.message}`);
    }
  }
  
  // Calculate final score and prepare report
  const score = (overallAiProb * 100).toFixed(1);
  
  reportData.ai_probability = parseFloat(score);
  reportData.code_quality = overallCodeQuality;
  reportData.patterns_detected = allPatterns;
  reportData.rationale = allRationales.join('\n\n');
  
  console.log(`\nOverall AI Analysis Results:`);
  console.log(`   AI probability score: ${score}%`);
  console.log(`   Code quality: ${overallCodeQuality}`);
  console.log(`   Patterns detected: ${allPatterns.length}`);
  
  for (const pattern of allPatterns) {
    console.log(`     - ${pattern}`);
  }
  
  return {
    ai_prob: overallAiProb,
    totalLines,
    licenseDetected,
    testFilesFound
  };
}

// Function to parse human-readable rules from text file
function parseHumanReadableRules(text) {
    const rules = [];
    const sections = text.split('## ').slice(1);
    
    for (const section of sections) {
        const lines = section.trim().split('\n');
        const title = lines[0].trim();
        const content = lines.slice(1).join(' ').trim();
        
        // Parse the condition from the content
        let condition = '';
        let message = content;
        let severity = 'warning';
        
        if (content.includes('flag this as an error')) {
            severity = 'error';
        }
        
        // Extract conditions based on the title and content
        if (title === 'High AI Confidence') {
            condition = 'ai_prob > 0.8';
        } else if (title === 'Medium AI Confidence') {
            condition = 'ai_prob > 0.6 && !license_comment';
        } else if (title === 'Likely AI Generated') {
            condition = 'ai_prob > 0.4 && !license_comment';
        } else if (title === 'Poor Comment Quality') {
            condition = 'ai_prob > 0.5';
        } else if (title === 'Grammar Issues') {
            condition = 'ai_prob > 0.3';
        } else if (title === 'Missing Context') {
            condition = 'ai_prob > 0.4 && lines_added > 100';
        } else if (title === 'Missing Tests') {
            condition = 'ai_prob > 0.5 && !tests_changed && lines_added > 50';
        } else if (title === 'Excessive Code') {
            condition = 'lines_added > 300 && ai_prob > 0.5';
        }
        
        // Only add rules that have valid conditions
        if (condition) {
            rules.push({
                name: title,
                condition: condition,
                severity: severity,
                message: message
            });
        }
    }
    
    return rules;
}

// Function to create and immediately close an issue with analysis results
async function createAndCloseRepoIssue(owner, repo, reportData) {
  try {
    console.log(`\nCreating issue with analysis results...`);
    
    // Format the issue body with analysis results
    const formattedPatterns = reportData.patterns_detected && reportData.patterns_detected.length > 0
      ? reportData.patterns_detected.map(pattern => `- ${pattern}`).join('\n')
      : 'None detected';
      
    const failuresText = reportData.failures && reportData.failures.length > 0
      ? reportData.failures.map(f => `- ${f}`).join('\n')
      : 'None';
      
    const warningsText = reportData.warnings && reportData.warnings.length > 0
      ? reportData.warnings.map(w => `- ${w}`).join('\n')
      : 'None';
    
    const issueBody = `
## AI Code Analysis Report

| Metric | Value |
|--------|-------|
| Repository | ${reportData.repository} |
| Analysis Date (UTC) | ${reportData.analysis_date} |
| AI Probability | **${reportData.ai_probability}%** |
| Files Analyzed | ${reportData.total_files || 0} |
| Total Lines | ${reportData.total_lines || 0} |
| Code Quality | ${reportData.code_quality || 'Unknown'} |
| License Detected | ${reportData.license_detected ? 'Yes' : 'No'} |
| Tests Found | ${reportData.tests_found ? 'Yes' : 'No'} |
| Status | ${reportData.analysis_status} |

### AI Patterns Detected
${formattedPatterns}

### Policy Failures
${failuresText}

### Policy Warnings
${warningsText}

### Analysis Summary
${reportData.rationale ? reportData.rationale.slice(0, 5000) + (reportData.rationale.length > 5000 ? '... (truncated)' : '') : 'No summary available'}

---
*This issue was automatically generated and closed by the AI Code Review Pipeline.*
`;

    // Create the issue
    const { data: issue } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
      owner,
      repo,
      title: `AI Code Analysis Report - ${new Date().toISOString()}`,
      body: issueBody,
      labels: ['ai-analysis', 'automated-report']
    });
    
    console.log(`\nIssue created successfully: ${issue.html_url}`);
    
    // Immediately close the issue
    await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
      owner,
      repo,
      issue_number: issue.number,
      state: 'closed'
    });
    
    console.log(`\nIssue closed successfully`);
    
    return issue.html_url;
  } catch (error) {
    console.error(`\nError with issue creation/closing: ${error.message}`);
    return null;
  }
}

async function analyzeRepository() {
  // Initialize report data object to collect information as we go
  const reportData = {
    analysis_date: new Date().toISOString(), // Using UTC ISO format
    analysis_status: 'started',
    error: null,
    repository: null,
    url: null,
    owner: null,
    repo: null,
    description: null,
    stars: null,
    forks: null,
    default_branch: null,
    created_at: null,
    updated_at: null,
    files_analyzed: 0,
    total_lines: 0,
    license_detected: false,
    tests_found: false,
    ai_probability: null,
    code_quality: null,
    patterns_detected: [],
    rationale: null,
    failures: [],
    warnings: []
  };

  try {
    // Prompt for repository URL
    const repoUrl = await new Promise(resolve => {
      rl.question('Enter GitHub repository URL (e.g., https://github.com/owner/repo): ', resolve);
    });

    reportData.url = repoUrl;
    console.log(`\nAnalyzing repository: ${repoUrl}`);
    
    // Extract owner and repo from URL
    const urlMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!urlMatch) {
      throw new Error('Invalid GitHub repository URL');
    }
    
    const owner = urlMatch[1];
    const repo = urlMatch[2].replace(/\.git$/, '');
    
    reportData.owner = owner;
    reportData.repo = repo;
    reportData.repository = `${owner}/${repo}`;
    
    console.log(`\nRepository details:`);
    console.log(`   Owner: ${owner}`);
    console.log(`   Repo: ${repo}`);

    // Fetch repository metadata
    const { data: repoData } = await octokit.request('GET /repos/{owner}/{repo}', {
      owner,
      repo
    });
    
    reportData.description = repoData.description || 'None';
    reportData.stars = repoData.stargazers_count;
    reportData.forks = repoData.forks_count;
    reportData.default_branch = repoData.default_branch;
    reportData.created_at = repoData.created_at;
    reportData.updated_at = repoData.updated_at;
    
    console.log(`\nRepository information:`);
    console.log(`   Description: ${reportData.description}`);
    console.log(`   Stars: ${reportData.stars}`);
    console.log(`   Forks: ${reportData.forks}`);
    console.log(`   Default branch: ${reportData.default_branch}`);
    console.log(`   Created: ${new Date(reportData.created_at).toLocaleString()}`);
    console.log(`   Last updated: ${new Date(reportData.updated_at).toLocaleString()}`);

    // Get all files in the repository (recursively)
    console.log(`\nFetching all files from repository...`);
    const allTreeItems = await getAllTreeItems(owner, repo, repoData.default_branch);
    
    console.log(`\nFound ${allTreeItems.length} files/directories in repository`);

    // Filter for only code files we want to analyze
    // Include all code file types without any exclusions
    const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.go', '.rb', '.php', '.html', '.css', '.scss', '.less', '.swift', '.kt', '.scala', '.rs', '.cs', '.vue', '.svelte', '.md', '.txt', '.sh', '.bat', '.ps1', '.json', '.yml', '.yaml', '.xml', '.sql', '.m', '.h', '.mm', '.dart', '.ex', '.exs', '.erl', '.lua', '.pl', '.pm', '.r', '.jl', '.clj', '.elm', '.hs', '.fs', '.ml', '.pde', '.pas', '.asm'];
    
    // Include all files except binary and known non-code files
    const codeFiles = allTreeItems.filter(item => 
      item.type === 'blob' && 
      !item.path.includes('node_modules/') &&
      !item.path.includes('.git/') &&
      !/\.(jpg|jpeg|png|gif|bmp|ico|svg|ttf|woff|woff2|eot|mp3|mp4|webm|ogg|wav|avi|mov|webp|zip|rar|tar|gz|7z|exe|dll|so|dylib|obj|lib|bin|apk|aab|ipa)$/i.test(item.path)
    );
    
    reportData.files_total = codeFiles.length;
    console.log(`\nFound ${codeFiles.length} code files for analysis`);
    
    // Analyze ALL code files - no sampling
    const filesToAnalyze = codeFiles;
    console.log(`\nAnalyzing all ${filesToAnalyze.length} files`);
    
    // Analyze code files in batches
    const analysisResults = await analyzeCodeBatches(filesToAnalyze, owner, repo, reportData);
    
    // Load evaluation rules from human-readable text file
    const rulesText = await fs.readFile(path.join(__dirname, 'review.txt'), 'utf8');
    const rules = parseHumanReadableRules(rulesText);
    let failures = [], warnings = [];

    // Apply each rule based on the context
    for (const rule of rules) {
      const ctx = { 
        ai_prob: analysisResults.ai_prob, 
        lines_added: analysisResults.totalLines,
        tests_changed: analysisResults.testFilesFound, 
        license_comment: analysisResults.licenseDetected 
      };
      const triggered = eval(rule.condition);
      if (triggered) {
        (rule.severity === 'error' ? failures : warnings).push(rule.message.trim());
      }
    }
    
    reportData.failures = failures;
    reportData.warnings = warnings;
    
    console.log(`\nPolicy Evaluation:`);
    console.log(`   Failures: ${failures.length}`);
    console.log(`   Warnings: ${warnings.length}`);
    
    for (const failure of failures) {
      console.log(`   FAILED: ${failure}`);
    }
    
    for (const warning of warnings) {
      console.log(`   WARNING: ${warning}`);
    }

    reportData.analysis_status = 'completed';
    
    // Save report to local file with UTC timestamp
    const reportFileName = `report-${owner}-${repo}-${Date.now()}.json`;
    await fs.writeFile(reportFileName, JSON.stringify(reportData, null, 2));
    console.log(`\nReport saved to ${reportFileName}`);
    
    // Create an issue in the repository with the analysis results and close it immediately
    const issueUrl = await createAndCloseRepoIssue(owner, repo, reportData);
    if (issueUrl) {
      reportData.issue_url = issueUrl;
      // Update the report file with the issue URL
      await fs.writeFile(reportFileName, JSON.stringify(reportData, null, 2));
    }
    
  } catch (error) {
    console.error(`\nError during repository analysis:`, error);
    reportData.analysis_status = 'failed';
    reportData.error = error.message;
  } finally {
    // Always close readline interface
    rl.close();
    
    try {
      // Create a more detailed Slack message with whatever data we have
      const formattedPatterns = reportData.patterns_detected && reportData.patterns_detected.length > 0
        ? reportData.patterns_detected.map(pattern => `  • ${pattern}`).join('\n')
        : 'Analysis incomplete';
          
      const failuresText = reportData.failures && reportData.failures.length > 0
        ? reportData.failures.map(f => `  • ${f}`).join('\n')
        : 'None or analysis incomplete';
          
      const warningsText = reportData.warnings && reportData.warnings.length > 0
        ? reportData.warnings.map(w => `  • ${w}`).join('\n')
        : 'None or analysis incomplete';
      
      // Prepare the repository info section
      const repoInfo = reportData.repository 
        ? `<${reportData.url || 'Unknown URL'}|${reportData.repository}>`
        : 'Unknown repository';
      
      // Prepare the AI score section
      const aiScore = reportData.ai_probability !== null
        ? `${reportData.ai_probability}% likelihood`
        : 'Analysis incomplete';
      
      // Create Slack message blocks
      const blocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `🔍 Repository AI Code Analysis ${reportData.error ? '(Failed)' : ''}`
          }
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Repository:*\n${repoInfo}`
            },
            {
              type: "mrkdwn",
              text: `*Status:*\n${reportData.analysis_status}`
            }
          ]
        }
      ];
      
      // Add repo metadata if available
      if (reportData.stars !== null) {
        blocks.push({
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Stars:*\n${reportData.stars || 0}`
            },
            {
              type: "mrkdwn",
              text: `*Forks:*\n${reportData.forks || 0}`
            }
          ]
        });
      }
      
      // Add analysis details if available
      if (reportData.files_analyzed > 0 || reportData.files_total > 0) {
        blocks.push({
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Files Analyzed:*\n${reportData.files_analyzed || 0} of ${reportData.files_total || 'unknown'}`
            },
            {
              type: "mrkdwn",
              text: `*Total Lines:*\n${reportData.total_lines || 0}`
            }
          ]
        });
      }
      
      // Add AI analysis if available
      if (reportData.ai_probability !== null) {
        blocks.push({
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*AI Score:*\n${aiScore}`
            },
            {
              type: "mrkdwn",
              text: `*Code Quality:*\n${reportData.code_quality || 'Analysis incomplete'}`
            }
          ]
        });
        
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*AI Patterns Detected:*\n${formattedPatterns}`
          }
        });
        
        if (reportData.rationale) {
          // Truncate rationale if it's too long for Slack
          const truncatedRationale = reportData.rationale.length > 2900 
            ? reportData.rationale.substring(0, 2900) + '... (truncated)'
            : reportData.rationale;
            
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Analysis Summary:*\n${truncatedRationale}`
            }
          });
        }
      }
      
      // Add policy evaluation if available
      if (reportData.failures || reportData.warnings) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Policy Failures:*\n${failuresText}`
          }
        });
        
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Policy Warnings:*\n${warningsText}`
          }
        });
      }
      
      // Add error information if present
      if (reportData.error) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Error:*\n\`\`\`${reportData.error}\`\`\``
          }
        });
      }
      
      // Add timestamp with UTC time
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Analysis performed at ${new Date().toISOString()} (UTC)`
          }
        ]
      });
      
      // Always send notification to Slack with whatever data we have
      await sendToSlack({ blocks });
      
    } catch (slackError) {
      console.error(`\nError sending to Slack: ${slackError}`);
    }
  }
}

// Run the analysis
analyzeRepository();