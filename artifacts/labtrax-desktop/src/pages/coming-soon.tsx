import { Sparkles } from "lucide-react";

interface Props {
  title: string;
  description?: string;
}

export default function ComingSoonPage({ title, description }: Props) {
  return (
    <div className="px-8 py-7">
      <div className="max-w-2xl mx-auto mt-12 bg-card border border-border rounded-xl p-10 text-center">
        <div className="h-12 w-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
          <Sparkles size={20} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground mt-2">
          {description ||
            "This area is coming soon to the desktop experience. The mobile app continues to handle this in the meantime."}
        </p>
      </div>
    </div>
  );
}
