import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/EmptyState";

/** Placeholder for sections whose milestone has not landed yet (see ROADMAP.md). */
export function UpcomingView({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return <EmptyState icon={icon} title={title} description={description} />;
}
