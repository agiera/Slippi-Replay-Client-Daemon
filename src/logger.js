const fs = require("fs");
const path = require("path");

function createLogger(app) {
  const logPath = path.join(app.getPath("userData"), "daemon.log");

  function log(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    console.log(line);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`);
  }

  return {
    info: (message) => log("INFO", message),
    warn: (message) => log("WARN", message),
    error: (message) => log("ERROR", message),
    logPath,
  };
}

module.exports = {
  createLogger,
};
