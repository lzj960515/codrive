export class WorkflowConflictError extends Error {
  override readonly name = "WorkflowConflictError";
}

export class InvalidTaskReportError extends Error {
  override readonly name = "InvalidTaskReportError";
}

export class ServiceNotReadyError extends Error {
  override readonly name = "ServiceNotReadyError";
}
