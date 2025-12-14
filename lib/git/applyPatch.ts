import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve, relative } from "path";

const execAsync = promisify(exec);

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface ParsedFilePatch {
  filePath: string;
  hunks: ParsedHunk[];
}

/**
 * Parses a unified diff patch into structured data
 */
function parsePatch(patch: string): ParsedFilePatch[] {
  const files: ParsedFilePatch[] = [];
  const lines = patch.split("\n");
  
  let currentFile: ParsedFilePatch | null = null;
  let currentHunk: ParsedHunk | null = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // File header
    if (line.startsWith("--- a/")) {
      if (currentFile && currentHunk) {
        currentFile.hunks.push(currentHunk);
      }
      if (currentFile) {
        files.push(currentFile);
      }
      currentFile = {
        filePath: line.substring(6).trim(),
        hunks: [],
      };
      currentHunk = null;
      continue;
    }
    
    if (line.startsWith("+++ b/")) {
      continue; // Skip, we already have the file path
    }
    
    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      continue;
    }
    
    // Hunk content
    if (currentHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "")) {
      currentHunk.lines.push(line);
    }
  }
  
  // Push last hunk and file
  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }
  
  return files;
}

/**
 * Finds the best matching position for a hunk in the file content using fuzzy matching
 */
function findBestMatch(fileLines: string[], hunk: ParsedHunk): number {
  // Extract the context and removed lines from the hunk (what we expect to find in the file)
  const searchLines: string[] = [];
  for (const line of hunk.lines) {
    if (line.startsWith(" ")) {
      searchLines.push(line.substring(1));
    } else if (line.startsWith("-")) {
      searchLines.push(line.substring(1));
    }
    // Skip "+" lines as they're additions, not in the original file
  }
  
  if (searchLines.length === 0) {
    return hunk.oldStart - 1; // Fall back to the original position
  }
  
  // Try exact match first at the expected position
  const expectedStart = hunk.oldStart - 1;
  if (matchesAt(fileLines, searchLines, expectedStart)) {
    return expectedStart;
  }
  
  // Search within a range around the expected position (fuzzy matching)
  const searchRange = 50; // Search within 50 lines of expected position
  let bestScore = -1;
  let bestPos = expectedStart;
  
  for (let offset = 0; offset <= searchRange; offset++) {
    // Try positions before and after expected
    for (const pos of [expectedStart - offset, expectedStart + offset]) {
      if (pos < 0 || pos > fileLines.length - searchLines.length) continue;
      
      const score = calculateMatchScore(fileLines, searchLines, pos);
      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
      
      // If we found a perfect match, return immediately
      if (score === searchLines.length) {
        return pos;
      }
    }
  }
  
  // If we found a reasonable match (at least 50% of lines match), use it
  if (bestScore >= searchLines.length * 0.5) {
    return bestPos;
  }
  
  // Fall back to original position
  return expectedStart;
}

/**
 * Checks if the search lines match exactly at the given position
 */
function matchesAt(fileLines: string[], searchLines: string[], pos: number): boolean {
  if (pos < 0 || pos + searchLines.length > fileLines.length) return false;
  
  for (let i = 0; i < searchLines.length; i++) {
    if (fileLines[pos + i] !== searchLines[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Calculates how many lines match at the given position (with trimmed comparison as fallback)
 */
function calculateMatchScore(fileLines: string[], searchLines: string[], pos: number): number {
  let score = 0;
  for (let i = 0; i < searchLines.length; i++) {
    if (pos + i >= fileLines.length) break;
    
    const fileLine = fileLines[pos + i];
    const searchLine = searchLines[i];
    
    // Exact match
    if (fileLine === searchLine) {
      score += 1;
    }
    // Trimmed match (whitespace differences)
    else if (fileLine.trim() === searchLine.trim()) {
      score += 0.8;
    }
  }
  return score;
}

/**
 * Applies a single hunk to file lines using fuzzy matching
 */
function applyHunkToLines(fileLines: string[], hunk: ParsedHunk): string[] {
  const result = [...fileLines];
  
  // Find the best matching position
  const matchPos = findBestMatch(fileLines, hunk);
  
  console.log(`[FUZZY APPLY] Hunk expected at line ${hunk.oldStart}, found best match at line ${matchPos + 1}`);
  
  // Build the replacement: collect lines to remove and lines to add
  const linesToRemove: number[] = [];
  const linesToAdd: string[] = [];
  let fileIndex = matchPos;
  
  for (const line of hunk.lines) {
    if (line.startsWith(" ")) {
      // Context line - verify it matches (with fuzzy matching)
      const contextLine = line.substring(1);
      if (fileIndex < result.length) {
        const fileLine = result[fileIndex];
        if (fileLine !== contextLine && fileLine.trim() === contextLine.trim()) {
          // Whitespace mismatch - preserve original file's whitespace
          linesToAdd.push(fileLine);
        } else {
          linesToAdd.push(contextLine);
        }
      } else {
        linesToAdd.push(contextLine);
      }
      fileIndex++;
    } else if (line.startsWith("-")) {
      // Line to remove
      linesToRemove.push(fileIndex);
      fileIndex++;
    } else if (line.startsWith("+")) {
      // Line to add
      linesToAdd.push(line.substring(1));
    }
  }
  
  // Calculate how many lines to replace
  const removeCount = hunk.oldCount;
  
  // Replace the lines
  result.splice(matchPos, removeCount, ...linesToAdd);
  
  return result;
}

/**
 * Applies a patch directly to files using fuzzy matching (fallback when git apply fails)
 */
async function applyPatchFuzzy(repoPath: string, patch: string): Promise<ApplyPatchResult> {
  console.log("[FUZZY APPLY] Attempting fuzzy patch application...");
  
  const parsedFiles = parsePatch(patch);
  const modifiedFiles: string[] = [];
  
  for (const filePatch of parsedFiles) {
    const filePath = join(repoPath, filePatch.filePath);
    
    if (!existsSync(filePath)) {
      return {
        success: false,
        modifiedFiles: [],
        error: `File not found: ${filePatch.filePath}`,
      };
    }
    
    let fileContent = readFileSync(filePath, "utf8");
    let fileLines = fileContent.split("\n");
    
    // Apply each hunk
    for (const hunk of filePatch.hunks) {
      fileLines = applyHunkToLines(fileLines, hunk);
    }
    
    // Write the modified file
    writeFileSync(filePath, fileLines.join("\n"), "utf8");
    modifiedFiles.push(filePatch.filePath);
    
    console.log(`[FUZZY APPLY] Successfully applied patch to ${filePatch.filePath}`);
  }
  
  return {
    success: true,
    modifiedFiles,
  };
}

interface ApplyPatchResult {
  success: boolean;
  modifiedFiles: string[];
  error?: string;
}

/**
 * Validates that a patch has the correct unified diff format
 * @param patch - Patch string to validate
 * @returns Error message if invalid, null if valid
 */
function validatePatchFormat(patch: string): string | null {
  if (!patch || !patch.trim()) {
    return "Patch is empty";
  }

  // Check for file headers
  if (!patch.includes("--- a/") || !patch.includes("+++ b/")) {
    return "Invalid patch format: missing file headers (--- a/ or +++ b/)";
  }

  // Check for hunk headers (allow @@ with or without numbers)
  if (!patch.includes("@@")) {
    return "Invalid patch format: missing hunk headers (@@)";
  }

  // Verify that file headers come before hunk headers
  const firstFileHeader = patch.indexOf("--- a/");
  const firstHunkHeader = patch.indexOf("@@");
  
  if (firstHunkHeader !== -1 && firstHunkHeader < firstFileHeader) {
    return "Invalid patch format: hunk headers appear before file headers";
  }

  // Check that we have matching file headers
  const fileHeaderCount = (patch.match(/--- a\//g) || []).length;
  const fileHeaderPlusCount = (patch.match(/\+\+\+ b\//g) || []).length;
  
  if (fileHeaderCount !== fileHeaderPlusCount) {
    return `Invalid patch format: mismatched file headers (${fileHeaderCount} --- a/ vs ${fileHeaderPlusCount} +++ b/)`;
  }

  return null;
}

/**
 * Applies a unified diff patch to a repository
 * @param repoPath - Absolute path to the repository
 * @param patch - Unified diff patch string
 * @returns Result with success status and list of modified files
 */
export async function applyPatch(
  repoPath: string,
  patch: string
): Promise<ApplyPatchResult> {
  // Check if we're in a serverless environment
  const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
  
  if (isServerless) {
    // In serverless, we can't use git apply
    // Return error indicating serverless limitation
    return {
      success: false,
      modifiedFiles: [],
      error: "Git operations are not available in serverless environments. Please use a self-hosted deployment or GitHub API integration.",
    };
  }

  // Validate repo path exists
  if (!existsSync(repoPath)) {
    return {
      success: false,
      modifiedFiles: [],
      error: `Repository path does not exist: ${repoPath}`,
    };
  }

  if (!existsSync(join(repoPath, ".git"))) {
    return {
      success: false,
      modifiedFiles: [],
      error: `Not a valid git repository: ${repoPath}`,
    };
  }

  // Validate patch format BEFORE attempting to apply
  const formatError = validatePatchFormat(patch);
  if (formatError) {
    return {
      success: false,
      modifiedFiles: [],
      error: `Patch was invalid: ${formatError}`,
    };
  }

  // Resolve to absolute path and normalize
  const absoluteRepoPath = resolve(repoPath);
  
  // Validate patch contains valid file paths (prevent directory traversal)
  const patchLines = patch.split("\n");
  const filePaths: string[] = [];
  
  for (const line of patchLines) {
    if (line.startsWith("--- a/") || line.startsWith("+++ b/")) {
      const filePath = line.substring(6).trim();
      if (filePath && filePath !== "/dev/null") {
        // Sanitize path
        const normalized = filePath.replace(/\.\./g, "").replace(/^\/+/, "");
        const fullPath = join(absoluteRepoPath, normalized);
        const relativePath = relative(absoluteRepoPath, fullPath);
        
        // Check for path traversal
        if (relativePath.startsWith("..") || relativePath.includes("..")) {
          return {
            success: false,
            modifiedFiles: [],
            error: `Invalid file path in patch: ${filePath}. Path traversal detected.`,
          };
        }
        
        filePaths.push(normalized);
      }
    }
  }

  // Write patch to temporary file EXACTLY as-is (no trimming, no escaping)
  const tempPatchFile = join(absoluteRepoPath, ".bugsmith-patch.tmp");
  
  try {
    // Write the patch exactly as received, preserving all whitespace and formatting
    writeFileSync(tempPatchFile, patch, "utf-8");

    // Apply patch using git apply with fuzzy matching (cross-platform)
    try {
      console.log("[APPLY PATCH] Running:", `git apply --unidiff-zero --ignore-whitespace "${tempPatchFile}"`);
      console.log("[APPLY PATCH] Patch file content:");
      console.log(readFileSync(tempPatchFile, "utf8"));
      
      const { stdout, stderr } = await execAsync(
        `git apply --unidiff-zero --ignore-whitespace "${tempPatchFile}"`,
        {
          cwd: absoluteRepoPath,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        }
      );

      // Check for reject files
      const rejectFiles: string[] = [];
      for (const filePath of filePaths) {
        const rejectFile = join(absoluteRepoPath, `${filePath}.rej`);
        if (existsSync(rejectFile)) {
          rejectFiles.push(filePath);
          try {
            unlinkSync(join(absoluteRepoPath, `${rejectFile}.rej`));
          } catch {
            // Ignore cleanup errors
          }
        }
      }

      if (rejectFiles.length > 0) {
        return {
          success: false,
          modifiedFiles: [],
          error: `Patch failed to apply. Some hunks could not be applied for files: ${rejectFiles.join(", ")}.`,
        };
      }

      // Get list of modified files from git status
      const { stdout: statusOutput } = await execAsync(
        "git status --porcelain",
        { cwd: absoluteRepoPath }
      );

      const modifiedFiles = statusOutput
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => line.substring(3).trim())
        .filter((file) => filePaths.includes(file) || filePaths.some((fp) => file.includes(fp)));

      return {
        success: true,
        modifiedFiles: modifiedFiles.length > 0 ? modifiedFiles : filePaths,
      };
    } catch (error: any) {
      // Check for reject files even on error
      const rejectFiles: string[] = [];
      for (const filePath of filePaths) {
        const rejectFile = join(absoluteRepoPath, `${filePath}.rej`);
        if (existsSync(rejectFile)) {
          rejectFiles.push(filePath);
          try {
            unlinkSync(rejectFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      }

      const errorMessage = error.stderr || error.message || "Unknown error";
      console.log(`[APPLY PATCH] git apply failed: ${errorMessage}`);
      console.log("[APPLY PATCH] Attempting fuzzy patch application as fallback...");
      
      // Try fuzzy matching fallback
      try {
        const fuzzyResult = await applyPatchFuzzy(absoluteRepoPath, patch);
        if (fuzzyResult.success) {
          console.log("[APPLY PATCH] Fuzzy patch application succeeded!");
          return fuzzyResult;
        }
        
        // If fuzzy also failed, return the combined error
        return {
          success: false,
          modifiedFiles: [],
          error: `Patch failed to apply. git apply error: ${errorMessage}. Fuzzy fallback error: ${fuzzyResult.error}`,
        };
      } catch (fuzzyError: any) {
        return {
          success: false,
          modifiedFiles: [],
          error: `Patch failed to apply. git apply error: ${errorMessage}. Fuzzy fallback also failed: ${fuzzyError.message}`,
        };
      }
    } finally {
      // Clean up temporary patch file
      try {
        if (existsSync(tempPatchFile)) {
          unlinkSync(tempPatchFile);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (error: any) {
    return {
      success: false,
      modifiedFiles: [],
      error: `Failed to write patch file: ${error.message || "Unknown error"}`,
    };
  }
}
