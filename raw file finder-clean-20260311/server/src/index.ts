import { createApp } from "./app.js";
import { config } from "./config.js";
import { warmDefaultLocalModel } from "./services/ai-matching.js";

createApp().listen(config.port, () => {
  console.log(`Raw File Finder server listening on http://localhost:${config.port}`);
  void warmDefaultLocalModel().catch((error) => {
    console.warn("AI warmup skipped:", error instanceof Error ? error.message : String(error));
  });
});
