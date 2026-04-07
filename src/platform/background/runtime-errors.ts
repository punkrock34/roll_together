export function runActionUpdate(update: Promise<unknown>) {
  void update.catch((error) => {
    if (!isIgnorableTabLifecycleError(error)) {
      console.error("Failed to update extension action state", error);
    }
  });
}

export function isIgnorableTabLifecycleError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return message.includes("No tab with id");
}

export function isIgnorablePortError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return (
    message.includes("Extension context invalidated") ||
    message.includes("disconnected port") ||
    message.includes("message channel is closed")
  );
}
