function log(level, message, data = {}) {
  console.log(JSON.stringify({ level, message, ...data, timestamp: new Date().toISOString() }));
}

module.exports = { log };
