/**
 * GitHub API operations for serverless environments
 * Uses GitHub API instead of Git commands
 */

interface GitHubFile {
  path: string;
  content: string;
  sha?: string;
}

/**
 * Get file contents from GitHub repository
 */
export async function getFileContent(
  repo: string,
  path: string,
  branch: string = "main"
): Promise<string> {
  const [owner, repoName] = repo.split("/");
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}?ref=${branch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "BugSmith",
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      return ""; // File doesn't exist, return empty
    }
    throw new Error(`Failed to fetch file: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.content) {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }
  return "";
}

/**
 * Get multiple file contents from GitHub
 */
export async function getFiles(
  repo: string,
  paths: string[],
  branch: string = "main"
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  
  // Fetch files in parallel
  await Promise.all(
    paths.map(async (path) => {
      try {
        const content = await getFileContent(repo, path, branch);
        files.set(path, content);
      } catch (error) {
        console.error(`Failed to fetch ${path}:`, error);
        files.set(path, ""); // Set empty on error
      }
    })
  );

  return files;
}

/**
 * List code files in a GitHub repository (recursively)
 * Returns paths to .js, .ts, .jsx, .tsx files
 */
export async function listCodeFiles(
  repo: string,
  branch: string = "main",
  path: string = "",
  maxFiles: number = 20
): Promise<string[]> {
  const [owner, repoName] = repo.split("/");
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }

  const files: string[] = [];
  
  async function scanDirectory(dirPath: string): Promise<void> {
    if (files.length >= maxFiles) return;

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${dirPath ? encodeURIComponent(dirPath) : ""}?ref=${branch}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "BugSmith",
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return; // Directory doesn't exist
      }
      throw new Error(`Failed to list directory: ${response.statusText}`);
    }

    const items = await response.json();
    
    // Handle both single file and array responses
    const entries = Array.isArray(items) ? items : [items];

    for (const item of entries) {
      if (files.length >= maxFiles) break;

      // Skip hidden files and common ignore directories
      if (item.name.startsWith(".") && item.name !== ".env" && item.name !== ".env.local") {
        continue;
      }
      if (item.name === "node_modules" || item.name === ".git" || item.name === "dist" || item.name === "build") {
        continue;
      }

      if (item.type === "file") {
        // Check if it's a code file
        if (/\.(js|ts|jsx|tsx)$/i.test(item.name)) {
          const filePath = dirPath ? `${dirPath}/${item.name}` : item.name;
          files.push(filePath);
        }
      } else if (item.type === "dir") {
        // Recursively scan subdirectories
        const subPath = dirPath ? `${dirPath}/${item.name}` : item.name;
        await scanDirectory(subPath);
      }
    }
  }

  await scanDirectory(path);
  return files.slice(0, maxFiles);
}

/**
 * Apply a unified diff patch by parsing it and updating files via GitHub API
 */
export function parsePatch(patch: string): Map<string, { oldContent: string; newContent: string }> {
  const changes = new Map<string, { oldContent: string; newContent: string }>();
  const lines = patch.split("\n");
  
  let currentFile: string | null = null;
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let inHunk = false;
  let oldLineNum = 0;
  let newLineNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header
    if (line.startsWith("--- a/")) {
      if (currentFile && oldLines.length > 0) {
        // Save previous file
        changes.set(currentFile, {
          oldContent: oldLines.join("\n"),
          newContent: newLines.join("\n"),
        });
      }
      currentFile = line.substring(6).trim();
      oldLines = [];
      newLines = [];
      inHunk = false;
    } else if (line.startsWith("+++ b/")) {
      // New file path (usually same as old)
      const newFile = line.substring(6).trim();
      if (newFile !== "/dev/null") {
        currentFile = newFile;
      }
    } else if (line.startsWith("@@")) {
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        oldLineNum = parseInt(match[1]) - 1; // Convert to 0-based
        newLineNum = parseInt(match[3]) - 1;
        inHunk = true;
      }
    } else if (inHunk && currentFile) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        // Added line
        newLines.push(line.substring(1));
        newLineNum++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        // Removed line
        oldLines.push(line.substring(1));
        oldLineNum++;
      } else if (line.startsWith(" ") || line === "") {
        // Context line (unchanged)
        const context = line.substring(1);
        oldLines.push(context);
        newLines.push(context);
        oldLineNum++;
        newLineNum++;
      }
    }
  }

  // Save last file
  if (currentFile && (oldLines.length > 0 || newLines.length > 0)) {
    changes.set(currentFile, {
      oldContent: oldLines.join("\n"),
      newContent: newLines.join("\n"),
    });
  }

  return changes;
}

/**
 * Create or update a file in GitHub repository
 */
export async function createOrUpdateFile(
  repo: string,
  path: string,
  content: string,
  branch: string,
  message: string,
  sha?: string
): Promise<{ success: boolean; sha?: string; error?: string }> {
  const [owner, repoName] = repo.split("/");
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    return { success: false, error: "GITHUB_TOKEN environment variable is not set" };
  }

  const body: any = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
  };

  if (sha) {
    body.sha = sha; // Required for updates
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "BugSmith",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    return {
      success: false,
      error: errorData.message || `Failed to update file: ${response.statusText}`,
    };
  }

  const data = await response.json();
  return {
    success: true,
    sha: data.content.sha,
  };
}

/**
 * Create a branch in GitHub repository
 */
export async function createBranch(
  repo: string,
  branchName: string,
  baseBranch: string = "main"
): Promise<{ success: boolean; error?: string }> {
  const [owner, repoName] = repo.split("/");
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    return { success: false, error: "GITHUB_TOKEN environment variable is not set" };
  }

  // First, get the SHA of the base branch
  const refResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${baseBranch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "BugSmith",
      },
    }
  );

  if (!refResponse.ok) {
    return { success: false, error: `Failed to get base branch: ${refResponse.statusText}` };
  }

  const refData = await refResponse.json();
  const baseSha = refData.object.sha;

  // Create the new branch
  const createResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/git/refs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "BugSmith",
      },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      }),
    }
  );

  if (!createResponse.ok) {
    const errorData = await createResponse.json().catch(() => ({}));
    // Branch might already exist, that's okay
    if (errorData.message?.includes("already exists")) {
      return { success: true };
    }
    return {
      success: false,
      error: errorData.message || `Failed to create branch: ${createResponse.statusText}`,
    };
  }

  return { success: true };
}

/**
 * Apply patch using GitHub API (for serverless environments)
 */
export async function applyPatchViaAPI(
  repo: string,
  patch: string,
  branchName: string,
  issueNumber: number | string
): Promise<{
  success: boolean;
  modifiedFiles: string[];
  commitHash?: string;
  error?: string;
}> {
  try {
    // Parse the patch to get file changes
    const changes = parsePatch(patch);
    const modifiedFiles: string[] = [];
    const errors: string[] = [];

    // Get current file SHAs for updates
    const fileSHAs = new Map<string, string>();
    for (const filePath of changes.keys()) {
      try {
        const [owner, repoName] = repo.split("/");
        const token = process.env.GITHUB_TOKEN;
        
        const response = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURIComponent(filePath)}?ref=${branchName}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "BugSmith",
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          fileSHAs.set(filePath, data.sha);
        }
      } catch (error) {
        // File doesn't exist, that's okay (it's a new file)
      }
    }

    // Apply changes to each file
    for (const [filePath, { newContent }] of changes.entries()) {
      const sha = fileSHAs.get(filePath);
      const message = `BugSmith: Fix for issue #${issueNumber} - Update ${filePath}`;

      const result = await createOrUpdateFile(repo, filePath, newContent, branchName, message, sha);

      if (result.success) {
        modifiedFiles.push(filePath);
        if (result.sha) {
          fileSHAs.set(filePath, result.sha);
        }
      } else {
        errors.push(`${filePath}: ${result.error}`);
      }
    }

    if (errors.length > 0 && modifiedFiles.length === 0) {
      return {
        success: false,
        modifiedFiles: [],
        error: `Failed to apply patch: ${errors.join("; ")}`,
      };
    }

    // Get the latest commit SHA from the branch
    let commitHash: string | undefined;
    try {
      const [owner, repoName] = repo.split("/");
      const token = process.env.GITHUB_TOKEN;
      
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${branchName}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "BugSmith",
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        commitHash = data.object.sha;
      }
    } catch (error) {
      // Commit hash is optional
    }

    return {
      success: modifiedFiles.length > 0,
      modifiedFiles,
      commitHash,
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  } catch (error: any) {
    return {
      success: false,
      modifiedFiles: [],
      error: error.message || "Failed to apply patch via GitHub API",
    };
  }
}

