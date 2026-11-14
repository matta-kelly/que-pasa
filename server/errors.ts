/** The server's refusals: an HTTP status and a code a client can act on, the same from every surface and operation. */
/** A request the server refuses, with its HTTP status and a code a client can act on. */
export class ServerError extends Error {
  override readonly name: string = "ServerError";
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 502;
  readonly code: string;
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 422 | 502,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
}

/** What a deployment's hook throws to refuse a request: 403 `forbidden`. */
export class Refused extends ServerError {
  override readonly name = "Refused";
  constructor(message: string) {
    super(403, "forbidden", message);
  }
}
