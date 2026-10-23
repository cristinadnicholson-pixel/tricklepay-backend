// ---------------------------------------------------------------------------
// Error handlers (#240).
//
// The global error handler and the not-found handler are registered here.
// Both attach the request id to the response body so a client-reported error
// can be matched to its log lines. Error messages are redacted before they
// leave the server (#74).
// ---------------------------------------------------------------------------

import type { FastifyError, FastifyInstance } from "fastify";

import { QueryTimeoutError } from "./db.js";
import { errorCodeForStatus, redactErrorMessage } from "./error-redaction.js";

import { REQUEST_ID_HEADER } from "./request-id.js";

function isDatabaseUnavailableError(err: unknown): boolean {
  if (err instanceof QueryTimeoutError) return true;

  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    return (
      message.includes("p1001") ||
      message.includes("p1002") ||
      message.includes("ecconnrefused") ||
      message.includes("can't reach database server") ||
      message.includes("database server") ||
      message.includes("connect econnrefused") ||
      message.includes("password authentication failed") ||
      message.includes("connection refused")
    );
  }

  return false;
}

/**
 * Registers the global error handler and the not-found handler on `app`.
 * Both handlers attach `requestId`, a stable `code`, and a redacted `error`
 * message to every failure response.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  // Attach the request id to error bodies so an error a client saw can be
  // traced to its log lines. Status codes are preserved and each failure
  // carries a stable machine-readable code (#73). Outgoing messages are
  // redacted so connection strings, SQL fragments, or stack traces never
  // reach the client (#74); the original error is logged server-side with
  // the request id for diagnosis.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const isDatabaseError = isDatabaseUnavailableError(err);
    const statusCode =
      isDatabaseError
        ? 503
        : typeof err.statusCode === "number" && err.statusCode >= 400
          ? err.statusCode
          : 500;
    if (statusCode >= 500) {
      request.log.error({ err }, "request failed");
    }
    if (isDatabaseError) {
      void reply.header("Retry-After", "30");
    }
    const message =
      statusCode >= 500
        ? "internal server error"
        : redactErrorMessage(err.message);
    void reply.status(statusCode).send({
      code: errorCodeForStatus(statusCode),
      error: message,
      requestId: request.id,
    });
  });

  // Unmatched routes bypass the error handler, so they get their own handler �
  // with the request id attached like every other error response.
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      code: errorCodeForStatus(404),
      error: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
  });
}
