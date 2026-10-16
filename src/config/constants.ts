/** Matches a Telegram voice note name: `voice_<ISO-8601 timestamp>.ogg`. */
export const VOICE_NOTE_PATTERN = /^voice_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.ogg$/;

/** Name of the file-backed database at the root of the output folder. */
export const DB_FILE = 'transcripts.json';

/** Subfolder of the output folder holding transcribed (and refined) files. */
export const PROCESSED_DIR = 'processed';

/** Subfolder of the output folder holding the generated Obsidian markdown notes. */
export const NOTES_DIR = 'notes';
