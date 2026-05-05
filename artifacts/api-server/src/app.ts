import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "node:path";
import router from "./routes";
import { corsOptions } from "./lib/cors";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);

// Serve uploaded case media files directly (outside /api prefix)
const casMediaDir = path.join(process.cwd(), "uploads", "case-media");
app.use("/uploads/case-media", express.static(casMediaDir));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
