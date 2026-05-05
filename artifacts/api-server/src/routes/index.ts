import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { registerRoutes } from "./labtrax-routes";

const router: IRouter = Router();

router.use(healthRouter);

// Mount LabTrax routes — initialised async at startup
let labtraxReady = false;
registerRoutes().then((labtraxRouter) => {
  router.use(labtraxRouter);
  labtraxReady = true;
}).catch((err) => {
  console.error("Failed to initialise LabTrax routes:", err);
});

export default router;
