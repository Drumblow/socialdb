export class NotInitializedError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotInitializedError";
  }
} 