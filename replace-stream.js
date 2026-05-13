const fs = require('fs');

const file = 'src/main/domains/cowork/service/coworkRunner.ts';
let content = fs.readFileSync(file, 'utf-8');
const originalLines = content.split('\n').length;

// Add import for coworkRunnerStream functions if not already present
const importBlock = `import {
  handleClaudeEvent,
  handleStreamEvent,
  finalizeStreamingContent,
  persistFinalResult,
} from './coworkRunnerStream';`;

if (!content.includes("from './coworkRunnerStream'")) {
  // Find the last import statement and insert after it
  const importLines = content.split('\n');
  let lastImportIndex = -1;
  for (let i = 0; i < importLines.length; i++) {
    if (importLines[i].startsWith('import ')) {
      lastImportIndex = i;
    }
  }
  if (lastImportIndex >= 0) {
    importLines.splice(lastImportIndex + 1, 0, importBlock);
    content = importLines.join('\n');
  }
}

// 1. Replace handleClaudeEvent calls (3 sites)
content = content.replace(
  /this\.handleClaudeEvent\(sessionId, event\)/g,
  `handleClaudeEvent(sessionId, event, activeSession, {
    store: this.store,
    emit: this.emit.bind(this),
    permissionManager: this.permissionManager,
    onHostToolExecution: this.handleHostToolExecution.bind(this),
    handleError: this.handleError.bind(this),
    isSessionStopRequested: this.isSessionStopRequested.bind(this),
    applyTurnMemoryUpdatesForSession: this.applyTurnMemoryUpdatesForSession.bind(this),
  })`
);

// 2. Replace handleStreamEvent calls (1 site)
content = content.replace(
  /this\.handleStreamEvent\(sessionId, activeSession, payload\)/g,
  `handleStreamEvent(sessionId, payload, activeSession, {
    store: this.store,
    emit: this.emit.bind(this),
  })`
);

// 3. Replace finalizeStreamingContent calls (5 sites)
content = content.replace(
  /this\.finalizeStreamingContent\(activeSession\)/g,
  `finalizeStreamingContent(activeSession, this.store, this.emit.bind(this))`
);

// 4. Replace persistFinalResult calls (1 site)
content = content.replace(
  /this\.persistFinalResult\(sessionId, activeSession, payload\.result\)/g,
  `persistFinalResult(sessionId, activeSession, this.store, this.emit.bind(this), payload.result)`
);

// 5. Delete the 4 private methods from coworkRunner.ts
// Methods to delete:
//   private handleClaudeEvent(...) { ... }   (starts around line 4512)
//   private handleStreamEvent(...) { ... }   (starts around line 4799)
//   private finalizeStreamingContent(...) { ... } (starts around line 5011)
//   private persistFinalResult(...) { ... }  (starts around line 5360)

const deleteMethod = (content, methodStartRegex, nextMethodRegex) => {
  const startMatch = content.match(methodStartRegex);
  if (!startMatch) {
    console.error('Could not find start pattern:', methodStartRegex.source);
    return content;
  }
  const startIdx = startMatch.index;

  const endMatch = content.match(nextMethodRegex);
  if (!endMatch) {
    console.error('Could not find end pattern:', nextMethodRegex.source);
    return content;
  }
  const endIdx = endMatch.index;

  // Find the newline before endIdx to keep it clean
  let cutEnd = endIdx;
  while (cutEnd > 0 && content[cutEnd - 1] === '\n') {
    cutEnd--;
  }

  return content.slice(0, startIdx) + content.slice(cutEnd);
};

// Delete handleClaudeEvent (goes until handleStreamEvent)
content = deleteMethod(
  content,
  /  private handleClaudeEvent\(sessionId: string, event: unknown\): void \{/,
  /  private handleStreamEvent\(/
);

// Delete handleStreamEvent (goes until finalizeStreamingContent)
content = deleteMethod(
  content,
  /  private handleStreamEvent\(/,
  /  private finalizeStreamingContent\(/,
);

// Delete finalizeStreamingContent (goes until waitForPermissionResponse)
content = deleteMethod(
  content,
  /  private finalizeStreamingContent\(activeSession: ActiveSession\): void \{/,
  /  private waitForPermissionResponse\(/
);

// Delete persistFinalResult (goes until extractText)
content = deleteMethod(
  content,
  /  private persistFinalResult\(/,
  /  private extractText\(/,
);

fs.writeFileSync(file, content);
const newLines = content.split('\n').length;
console.log(`Removed ${originalLines - newLines} lines. Original: ${originalLines}, New: ${newLines}`);
