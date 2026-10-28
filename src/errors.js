class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const notFound = (code, message) => new AppError(404, code, message);
const conflict = (code, message, details) => new AppError(409, code, message, details);
const unprocessable = (code, message) => new AppError(422, code, message);

module.exports = { AppError, badRequest, notFound, conflict, unprocessable };
