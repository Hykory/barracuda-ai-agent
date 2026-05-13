const fs = require("fs");
const path = require("path");

const logsDir = "./logs";

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

function writeCallLog(callId, data) {
  const filePath = path.join(logsDir, `${callId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

module.exports = { writeCallLog };