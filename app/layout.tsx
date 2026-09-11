import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Workspace · Your daily overview",
  description: "A personal workspace for your day, priorities, and independent work.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
