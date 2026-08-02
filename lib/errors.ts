export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  readonly status = 400;
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

/**
 * The request is well formed but the record is not in a state that allows it —
 * work the user must complete first, not input to correct.
 */
export class PrerequisiteError extends Error {
  readonly status = 409;
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "PrerequisiteError";
    this.details = details;
  }
}
