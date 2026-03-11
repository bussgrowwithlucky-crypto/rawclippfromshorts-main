import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import { config } from "./config.js";
import { apiRouter } from "./routes/api.js";

declare module "express-session" {
  interface SessionData {
    frameioBearerToken?: string;
    frameioSessionCookie?: string;
  }
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 8,
        sameSite: "lax",
      },
    }),
  );
  app.use("/api", apiRouter);
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    response.status(400).json({ message });
  });
  return app;
}
