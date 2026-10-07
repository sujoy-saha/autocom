import type { ReactNode } from "react";
import { Plus_Jakarta_Sans, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "./components/ThemeProvider";

// Bolder, friendlier type pairing than the old plain system-font stack:
// Space Grotesk for headings/brand (confident, geometric), Plus Jakarta
// Sans for body copy (rounder and warmer than Inter, still highly legible).
const displayFont = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });
const bodyFont = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-body", weight: ["400", "500", "600", "700", "800"] });

export const metadata = {
  title: "AutoCom",
  description:
    "AutoCom — B2B order-automation platform: multi-agent order orchestration powered by NVIDIA Nemotron on Nebius Token Factory.",
};

// Applies the saved theme preference before first paint (blocking, runs
// before hydration) so there's no flash of the wrong theme — mirrors what
// ThemeProvider does on the client afterwards, from the same localStorage key.
const themeInitScript = `
(function () {
  try {
    var pref = localStorage.getItem("ac_theme_v2") || "dark";
    var resolved = pref === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : pref;
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
