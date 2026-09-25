import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// next/font/google self-hosts the font at build time (no runtime request to
// Google Fonts, no layout-shift flash-of-unstyled-text) and exposes it as a
// CSS variable we read from globals.css. This is the current Next.js best
// practice over a manual <link rel="stylesheet"> tag.
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800', '900'],
  variable: '--font-archivo',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata = {
  metadataBase: new URL('https://fade-nu.vercel.app'),
  title: 'FADE. — Book your next cut in 30 seconds',
  description: 'Pick your barber, lock a slot, drop a $15 deposit. No queues, no no-shows.',
  openGraph: {
    title: 'FADE. — Book your next cut in 30 seconds',
    description: 'Pick your barber, lock a slot, drop a $15 deposit. No queues, no no-shows.',
    url: 'https://fade-nu.vercel.app',
    images: ['/og-image.png'],
  },
  twitter: { card: 'summary_large_image', images: ['/og-image.png'] },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
