import { defineConfig } from "vitest/config";

// Pin test process to America/Mexico_City to match production systemd TZ.
// slot-finder + datetime-parser use Date.setHours/getHours/getDay (local-TZ)
// for working-hour math; without this, tests pass in UTC env but hide bugs
// the same code reveals when running on the MX-TZ VPS. Per global
// feedback_timezone_utc rule.
process.env.TZ = "America/Mexico_City";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
