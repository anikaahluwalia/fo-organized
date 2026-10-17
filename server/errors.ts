/** An error with a user-facing message and the HTTP status to report it with. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code?: string) => new AppError(400, message, code);
export const notFound = (message = "Not found.") => new AppError(404, message);
export const conflict = (message: string, code?: string) => new AppError(409, message, code);
