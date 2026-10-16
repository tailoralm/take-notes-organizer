import 'dotenv/config';
import { loadConfig } from './config/config';
import { consoleLogger } from './core/logger';
import { copyAll } from './services/copy-service';
import { processAll } from './services/process-service';

async function main(): Promise<void> {
  const config = loadConfig();
  await copyAll(config, consoleLogger);
  await processAll(config, consoleLogger);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
