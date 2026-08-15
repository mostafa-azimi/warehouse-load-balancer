import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Balance | Inventory intelligence",
  description: "ShipHero warehouse inventory load balancing for 3PL operators",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
