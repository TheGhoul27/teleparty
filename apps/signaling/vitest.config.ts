import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration suite binds real sockets; serialising files avoids a
    // flaky worker-IPC teardown race on Windows.
    fileParallelism: false,
    teardownTimeout: 10_000
  }
});
