const STORAGE_MODULE_URL = new URL("./stub-storage.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@google-cloud/storage") {
    return { url: STORAGE_MODULE_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
