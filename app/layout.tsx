import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Context Listener',
  description: 'Real-time AI context cards for what you watch and listen to.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
