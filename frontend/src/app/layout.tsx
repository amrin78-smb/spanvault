import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { CORNERS_INIT_SCRIPT } from '@/lib/corners';
import { LicenseProvider, LicenseGate } from '@/components/LicenseGuard';

export const metadata: Metadata = {
  title: 'SpanVault — Network Monitoring',
  description: 'SpanVault NMS, part of the NocVault suite',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Apply saved dark/light theme before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Same deal for the rounded/square corner preference: it lives in
            localStorage, so it can only be read in the browser and must run
            SYNCHRONOUSLY here (not as an import/effect) — otherwise the first
            paint uses the rounded defaults and visibly snaps to square. */}
        <script dangerouslySetInnerHTML={{ __html: CORNERS_INIT_SCRIPT }} />
      </head>
      <body>
        {/* LicenseProvider + LicenseGate live at the ROOT so the full-screen
            lock hard-blocks EVERY route on a disabled license — including the
            SSO landing and the public/NOC map pages that sit OUTSIDE the (app)
            route group. The gate fails open (renders children) while loading
            and for every non-disabled license mode. */}
        <Providers>
          <LicenseProvider>
            <LicenseGate>{children}</LicenseGate>
          </LicenseProvider>
        </Providers>
      </body>
    </html>
  );
}
