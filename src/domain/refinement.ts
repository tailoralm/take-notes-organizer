/** Title, tags, resume and refined body produced by the LLM for one transcription. */
export interface RefineResult {
  title: string;
  tags: string[];
  resume: string;
  refinedText: string;
}
