import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const hookSource = fs.readFileSync(
  path.resolve(testDir, '../useServerTaskPolling.ts'),
  'utf8',
);

describe('useServerTaskPolling completion error handling', () => {
  it('marks completed task finalization failures as recoverable instead of swallowing them', () => {
    expect(hookSource).toContain('handleCompletedTaskFinalizationError');
    expect(hookSource).toContain('finalizeCompletedServerTask(currentJob, task, actions)');
    expect(hookSource).toContain('.catch(error => handleCompletedTaskFinalizationError');
    expect(hookSource).toContain('actions.failJob(job.id');
    expect(hookSource).not.toContain("catch(() => { /* 已落库 */ })");
  });
});
