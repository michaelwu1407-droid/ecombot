import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sales agent',
  description: 'An AI sales agent for social-first boutiques',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
