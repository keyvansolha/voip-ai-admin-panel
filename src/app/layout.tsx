import type { Metadata, Viewport } from 'next';
import { getTranslator } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'VoIP AI Manager',
  description: 'Call recording ingestion, AI analysis and delivery for Asterisk',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir } = await getTranslator();

  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
