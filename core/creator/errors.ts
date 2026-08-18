/** Loud-failure class for the Creator pipeline (validator, mapper, compiler,
 *  package writer). The name predates the AI-paste flow — it is kept because
 *  thrown messages and tests reference it. */
export class StoryboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryboardError';
  }
}
