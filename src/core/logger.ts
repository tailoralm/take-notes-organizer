/** Sink for pipeline progress. The CLI prints to the console; the server streams NDJSON. */
export interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  success: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
