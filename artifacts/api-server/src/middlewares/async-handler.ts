import type { NextFunction, Request, Response } from "express";

// Express 5's ParamsDictionary uses `string | string[]` as its value type, but
// route path parameters are always plain strings (never arrays). Narrowing
// params to `Record<string, string>` here gives all route handlers a clean
// `string` type for req.params.xxx without needing casts at every call-site.
type FlatRequest = Omit<Request, "params"> & { params: Record<string, string> };

export function asyncHandler(
  fn: (req: FlatRequest, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as unknown as FlatRequest, res, next)).catch(next);
  };
}
