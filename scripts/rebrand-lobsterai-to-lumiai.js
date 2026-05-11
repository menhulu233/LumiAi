const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

const replacements = [
  { from: 'LumiAi', to: 'LumiAi' },
  { from: 'lumiai', to: 'lumiai' },
  { from: 'LUMIAI', to: 'LUMIAI' },
];

const skipDirs = [
  'node_modules',
  '.git',
  'release',
  'dist',
  'dist-electron',
];

function shouldSkip(filePath) {
  return skipDirs.some(dir => filePath.includes(dir));
}

function replaceInFile(filePath) {
  if (shouldSkip(filePath)) return { file: filePath, skipped: true };

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    let modified = false;
    let newContent = content;

    for (const { from, to } of replacements) {
      if (newContent.includes(from)) {
        newContent = newContent.split(from).join(to);
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync(filePath, newContent, 'utf8');
      return { file: filePath, modified: true };
    }
    return { file: filePath, modified: false };
  } catch (err) {
    return { file: filePath, error: err.message };
  }
}

function walkDir(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkip(fullPath)) {
        results.push(...walkDir(fullPath));
      }
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

const allFiles = walkDir(rootDir);
const results = [];

for (const file of allFiles) {
  const result = replaceInFile(file);
  if (result.modified) {
    results.push(result.file);
  }
}

console.log(`Modified ${results.length} files:`);
results.forEach(f => console.log('  ' + f));
