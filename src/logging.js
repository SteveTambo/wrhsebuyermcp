function redact(value) {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|api[-_ ]?key|checkout[-_ ]?token|access[-_ ]?token|secret|private[-_ ]?key)\b(\s*[:=]\s*)["']?[^,\s"'<>]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/([?&][^=\s&]+)=([^&\s]+)/g, "$1=[REDACTED]");
}

function errorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redact(error.message),
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      ...(typeof error.stack === "string"
        ? { stack: redact(error.stack) }
        : {}),
    };
  }
  return {
    name: typeof error,
    message: redact(String(error)),
  };
}

export function logError(event, error, details = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level: "error",
    component: "wrhse-buyer",
    event,
    ...details,
    error: errorDetails(error),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
