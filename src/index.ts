import 'dotenv/config';
import { consoleLogger, loadConfig, processAll } from './processor';

async function main(): Promise<void> {
  const config = loadConfig();
  await processAll(config, consoleLogger);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });