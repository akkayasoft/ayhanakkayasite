const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function defaultData() {
  return {
    users: [],
    categories: [],
    tasks: [],
    taskStatuses: [],
    dailyQuestions: [],
    pointLogs: []
  };
}

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData(), null, 2), 'utf-8');
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');

  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultData(),
      ...parsed
    };
  } catch (err) {
    return defaultData();
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function updateDb(mutator) {
  const data = readDb();
  mutator(data);
  writeDb(data);
  return data;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

module.exports = {
  readDb,
  writeDb,
  updateDb,
  makeId
};
