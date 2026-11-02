/**
 * Thrown when a verb is called with an argument it can't use. Nothing has been sent to GitHub
 * when this is thrown, so a caller can fix the argument and try again.
 */
export class InvalidArgument extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgument";
  }
}

/**
 * Checks a list of names (labels or GitHub logins) before it goes to GitHub, and returns the
 * names trimmed.
 *
 * The host calls a verb with exactly one argument, so the names have to arrive as one array:
 * `issue.addLabels(["bug", "ui"])`. An empty list, a name that is blank, or anything that
 * isn't a string is refused here, because GitHub would refuse it anyway, less clearly.
 *
 * @param value what the verb was called with
 * @param verb the verb's name, for the error message
 * @param noun what one name is, e.g. "label" or "reviewer"
 * @return the names, trimmed
 * @throws InvalidArgument when the list is missing, empty, or holds a blank or non-string name
 */
export function nameList(value: unknown, verb: string, noun: string): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidArgument(`${verb} takes one array of ${noun}s, e.g. ${verb}(["${noun}"])`);
  }
  if (value.length === 0) throw new InvalidArgument(`${verb} needs at least one ${noun}`);
  return value.map((name, index) => {
    if (typeof name !== "string" || name.trim() === "") {
      throw new InvalidArgument(`${verb} got an empty ${noun} at position ${index}; every ${noun} needs a name`);
    }
    return name.trim();
  });
}
