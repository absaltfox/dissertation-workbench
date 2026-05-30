import { ensureStorage, getDb } from '../src/db.js';
import { rebuildConceptDictionary } from '../src/conceptsPipeline.js';

async function main() {
  await ensureStorage();
  await getDb();
  const result = await rebuildConceptDictionary({ trigger: 'script' });
  if (!result.ok) {
    console.error(result.error || 'Concept rebuild failed');
    process.exitCode = 1;
    return;
  }
  console.log('Concept rebuild complete:', JSON.stringify(result.artifact?.stats || {}, null, 2));
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
