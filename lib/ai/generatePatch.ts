import "@/lib/loadEnv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import type { Issue } from "@/components/issue-card";

const client = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

interface GeneratePatchParams {
  repoPath: string;
  issue: Issue;
  files: string[];
  repo?: string; // Repository in format "owner/repo" for serverless mode
  branch?: string; // Branch name for fetching files in serverless mode
}

/**
 * Removes code fences from patch output and returns the patch as-is
 * @param patch - Raw patch string from the model
 * @returns Patch with code fences removed
 */
function sanitizePatch(patch: string): string {
  if (!patch) return "";

  return patch
    .replace(/```diff/g, "")
    .replace(/```patch/g, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * Removes blank lines immediately after hunk headers (@@)
 * @param patch - Patch string that may have blank lines after hunk headers
 * @returns Patch with leading blank lines in hunks removed
 */
function removeLeadingBlankLinesInHunks(patch: string): string {
  if (!patch) return "";

  const lines = patch.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result.push(line);

    // If this is a hunk header, remove any blank lines that follow
    if (line.trim() === "@@" || line.startsWith("@@")) {
      // Skip blank lines immediately after the hunk header
      while (i + 1 < lines.length && lines[i + 1].trim() === "") {
        i++; // Skip the blank line
      }
    }
  }

  return result.join("\n");
}

/**
 * Injects proper line number metadata into @@ hunk headers AND
 * adds space prefix to context lines.
 * Git requires: @@ -start,count +start,count @@
 * Git requires: context lines start with a space
 */
function injectHunkLineNumbers(patch: string, repoPath: string): string {
  if (!patch) return "";

  const lines = patch.split("\n");
  const result: string[] = [];
  
  let currentFile: string | null = null;
  let fileLines: string[] = [];
  let inHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track current file
    if (line.startsWith("--- a/")) {
      currentFile = line.replace("--- a/", "").trim();
      if (currentFile) {
        const filePath = path.join(repoPath, currentFile);
        if (fs.existsSync(filePath)) {
          fileLines = fs.readFileSync(filePath, "utf8").split("\n");
        } else {
          fileLines = [];
        }
      }
      result.push(line);
      inHunk = false;
      continue;
    }

    if (line.startsWith("+++ b/")) {
      result.push(line);
      continue;
    }

    // Detect bare @@ header (needs line numbers)
    if ((line.trim() === "@@" || line === "@@") && currentFile) {
      // Collect all lines in this hunk until next @@ or file header or end
      const hunkLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const hunkLine = lines[j];
        if (hunkLine.startsWith("@@") || hunkLine.startsWith("--- a/") || hunkLine.startsWith("+++ b/")) {
          break;
        }
        hunkLines.push(hunkLine);
        j++;
      }

      // Calculate old and new line counts
      let oldCount = 0;
      let newCount = 0;
      let firstContextLine: string | null = null;

      for (const hLine of hunkLines) {
        if (hLine.startsWith("-") && !hLine.startsWith("---")) {
          oldCount++;
          if (!firstContextLine) firstContextLine = hLine.substring(1);
        } else if (hLine.startsWith("+") && !hLine.startsWith("+++")) {
          newCount++;
        } else if (hLine.startsWith(" ")) {
          // Context line (with space prefix)
          oldCount++;
          newCount++;
          if (!firstContextLine) firstContextLine = hLine.substring(1);
        } else if (hLine.trim() !== "") {
          // Context line without prefix (model didn't add space)
          oldCount++;
          newCount++;
          if (!firstContextLine) firstContextLine = hLine;
        }
      }

      // Find start line by matching first context or removed line in file
      let startLine = 1;
      if (firstContextLine && fileLines.length > 0) {
        const idx = fileLines.findIndex(fl => fl === firstContextLine || fl.trim() === firstContextLine.trim());
        if (idx !== -1) {
          startLine = idx + 1;
        }
      }

      // Generate proper hunk header
      const newHeader = `@@ -${startLine},${oldCount} +${startLine},${newCount} @@`;
      result.push(newHeader);
      inHunk = true;
      continue;
    }

    // Handle @@ headers that already have line numbers
    if (line.startsWith("@@")) {
      result.push(line);
      inHunk = true;
      continue;
    }

    // Inside a hunk - fix context lines that don't have space prefix
    if (inHunk) {
      // Already properly prefixed lines
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        result.push(line);
        continue;
      }
      
      // Empty line in hunk - add space prefix
      if (line === "") {
        result.push(" ");
        continue;
      }
      
      // Context line without prefix - add space
      result.push(" " + line);
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Enforces unified diff format and prevents hallucinated patches.
 */
export async function generatePatch({ repoPath, issue, files, repo, branch = "main" }: GeneratePatchParams): Promise<string> {
  let fullPrompt = `
You are a patch generator. You output ONLY unified diff patches that apply cleanly using "git apply".

You MUST output a valid unified diff patch that git apply can successfully apply.

CRITICAL RULES FOR EACH HUNK - THESE ARE MANDATORY:
1. EVERY hunk MUST start with at least 3-5 lines of UNCHANGED context from the file BEFORE the change.
   - More context = better. Git needs enough context to uniquely locate the change.
   - If the change is near the start of the file, include as much context as possible from the beginning.
2. EVERY hunk MUST end with at least 3-5 lines of UNCHANGED context from the file AFTER the change.
   - More context = better. Git needs enough context to uniquely locate the change.
   - If the change is near the end of the file, include as much context as possible to the end.
3. The context lines must appear EXACTLY as they do in the file - no prefixes, no modifications, no spaces added.
4. Between the context lines, include your changes with '-' for removed lines and '+' for added lines.
5. NEVER start a hunk immediately with a '-' or '+' line after @@ - always include context first.
6. The FIRST line after @@ MUST be an unchanged context line, never a '+' or '-' line.

EXAMPLE OF CORRECT HUNK FORMAT:
If the file contains:
  const x = 1;
  function test() {
    return x;
  }
  const y = 2;

And you need to change "return x;" to "return x + 1;", the hunk should be:
@@
  const x = 1;
  function test() {
-    return x;
+    return x + 1;
  }
  const y = 2;

Notice: The hunk starts with 2 context lines before the change and ends with 1 context line after.

RULES:
1. Every hunk MUST include at least two lines of real unchanged context before and after each modification.
2. Unchanged lines must be copied EXACTLY as they appear in the file, with no added or removed spaces.
3. Removed lines must be prefixed with '-' and added lines with '+'.
4. NEVER output a hunk that contains only '+' lines or only '-' lines.
5. NEVER output consecutive @@ headers. Each hunk must contain context and modifications.
6. DO NOT output explanation text or comments.
7. DO NOT wrap the output in code fences.
8. FOR EACH FILE, YOU MUST GENERATE EXACTLY ONE UNIFIED DIFF HUNK. All changes must be included in a SINGLE @@ block. Do NOT create multiple hunks. Do NOT duplicate code. Do NOT relocate or rewrite unrelated lines. Do NOT generate changes outside the exact locations shown in the file.
9. Only output:
    --- a/<file>
    +++ b/<file>
    @@
    <context lines before>
    <changed lines with - and +>
    <context lines after>
10. Ensure the context lines match the exact file contents we provide.
11. Only output one @@ block per file. All changes must appear inside the same hunk.

CRITICAL: You MUST NOT modify indentation, spacing, blank lines, or formatting of unchanged lines.

You MUST copy unchanged lines EXACTLY as they appear in the file, byte-for-byte.

When generating a unified diff:
- The '-' line must be character-for-character identical to the original file.
- Unchanged context lines must be character-for-character identical to the original file.
- Only '+' lines may differ.

If you cannot match the line exactly, DO NOT change it.

Never rewrite code or reformat unrelated lines.

DO NOT modify formatting, whitespace, indentation, semicolons, or spacing of unchanged lines.

DO NOT rewrite code outside the changed lines.

Below is the issue to fix:

ISSUE #${issue.number || issue.id}
Title: ${issue.title}
Body: ${issue.body || "No description"}

Now here are the ACTUAL FILE CONTENTS. Use these EXACT contents when generating the patch.

`;

  // Check if we're in a serverless environment
  const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;

  // Inject full file contents
  for (const file of files) {
    let content: string;
    
    if (isServerless && repo) {
      // In serverless, get file content from GitHub API
      try {
        const { getFileContent } = await import("@/lib/github/apiOperations");
        content = await getFileContent(repo, file, branch);
      } catch (error) {
        console.error(`Failed to fetch ${file} from GitHub:`, error);
        content = "";
      }
    } else {
      // Use file system
      const absPath = path.join(repoPath, file);
      try {
        content = fs.readFileSync(absPath, "utf8");
      } catch (error) {
        console.error(`Failed to read ${file}:`, error);
        content = "";
      }
    }

    fullPrompt += `
FILE: ${file}
-----------------------------------
${content}
-----------------------------------
END FILE
`;
  }

  fullPrompt += `
Generate ONE unified diff patch that applies cleanly.
Remember:
- Only output patch lines.
- Use @@ (no numbers) for hunk headers.
- FOR EACH FILE: Generate EXACTLY ONE @@ block. All changes for that file must be in a single hunk.
- EVERY hunk MUST start with 3-5 unchanged context lines from BEFORE the change (more is better).
- EVERY hunk MUST end with 3-5 unchanged context lines from AFTER the change (more is better).
- The FIRST line after @@ MUST be an unchanged context line, never a '+' or '-' line.
- Copy unchanged context lines EXACTLY as they appear in the file (byte-for-byte, no prefixes).
- Only '+' lines may differ from the original.
- Do NOT create multiple hunks per file. All changes must be in ONE hunk per file.
- No commentary.
- No code fences.
- No blank lines at the end.

IMPORTANT: If a hunk starts immediately after @@ with a '-' or '+' line, it is WRONG. You MUST include unchanged context lines first.
`;

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: [
      { 
        role: "system", 
        content: "You output ONLY valid git unified diff patches. Use context-only hunk headers (just @@) without line numbers. Git will match by context. CRITICAL: FOR EACH FILE, generate EXACTLY ONE hunk. All changes for a file must be in a single @@ block. Every hunk MUST start with 2-3 unchanged context lines BEFORE the change and end with 2-3 unchanged context lines AFTER the change. These context lines must appear exactly as they do in the file with no prefixes or modifications. You MUST copy unchanged lines EXACTLY as they appear in the file, byte-for-byte. Only '+' lines may differ from the original. DO NOT add spaces to context lines. NEVER start a hunk immediately with a '-' or '+' line - always include context lines first." 
      },
      { role: "user", content: fullPrompt },
    ],
    temperature: 0,
  });

  let patch = completion.choices[0].message.content || "";

  console.log("=== RAW MODEL OUTPUT START ===");
  console.log(patch);
  console.log("=== RAW MODEL OUTPUT END ===");

  // Remove code fences only - return patch as-is
  let sanitizedPatch = sanitizePatch(patch);

  // Remove blank lines immediately after hunk headers
  sanitizedPatch = removeLeadingBlankLinesInHunks(sanitizedPatch);

  // Inject proper line numbers into hunk headers (git requires @@ -start,count +start,count @@)
  sanitizedPatch = injectHunkLineNumbers(sanitizedPatch, repoPath);

  console.log("=== FINAL PATCH BEFORE APPLY ===");
  console.log(sanitizedPatch);

  return sanitizedPatch;
}
