import { useEffect, useState } from "react";
import {
  coerceInvoiceTemplate,
  type InvoiceTemplate,
} from "./invoice-template";

async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "include" });
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Resolves a per-lab invoice template (from the /me payload) and
 * preloads every extra image as a data URL so the PDF renderer can
 * embed it synchronously. Falls back to the default layout when the
 * lab has not opened the editor.
 */
export function useInvoiceTemplate(
  practiceInvoiceTemplate: unknown,
): {
  template: InvoiceTemplate;
  extraImageDataUrls: Record<string, string>;
} {
  const template = coerceInvoiceTemplate(practiceInvoiceTemplate);
  const [extraImageDataUrls, setDataUrls] = useState<Record<string, string>>({});

  // Re-key on the joined image URL list so we re-fetch only on changes.
  const urls = template.extraImages.map((img) => img.url);
  const key = urls.join("|");

  useEffect(() => {
    if (urls.length === 0) {
      setDataUrls({});
      return;
    }
    let cancelled = false;
    Promise.all(
      urls.map((u) =>
        urlToDataUrl(u)
          .then((d) => [u, d] as const)
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const p of pairs) if (p) next[p[0]] = p[1];
      setDataUrls(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { template, extraImageDataUrls };
}
