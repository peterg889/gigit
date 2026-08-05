const path = require("node:path");

const defaultSupervisorPath = path.join(__dirname, "e2e-server.mjs");

function quoteShellArgument(value, platform) {
  if (platform === "win32") {
    if (/["\r\n]/.test(value)) {
      throw new Error("Windows command arguments cannot contain quotes or newlines");
    }
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * Playwright accepts its web-server command as a shell string. Pinning both
 * paths makes it use the same Node runtime as Playwright and avoids requiring
 * a globally-installed package manager merely to start the supervisor.
 */
function createPlaywrightSupervisorCommand(
  {
    nodeExecutable = process.execPath,
    supervisorPath = defaultSupervisorPath,
    platform = process.platform,
  } = {},
) {
  return [
    quoteShellArgument(nodeExecutable, platform),
    quoteShellArgument(supervisorPath, platform),
  ].join(" ");
}

module.exports = { createPlaywrightSupervisorCommand };
