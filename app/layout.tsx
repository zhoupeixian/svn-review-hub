import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import ThemeSwitcher from './components/theme-switcher';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const siteOrigin = process.env.SITE_ORIGIN?.replace(/\/$/, '');
const socialImage = siteOrigin ? siteOrigin + '/og.png' : undefined;

export const metadata: Metadata = {
  title: 'ZHERP SVN 审查日志',
  description: '团队可随时查阅的 ZHERP 当日 SVN 提交审查日志。',
  metadataBase: siteOrigin ? new URL(siteOrigin) : undefined,
  openGraph: {
    title: 'ZHERP SVN 审查日志',
    description: '每天的提交判断，沉淀为团队工程记忆。',
    type: 'website',
    images: socialImage
      ? [
          {
            url: socialImage,
            width: 1200,
            height: 630,
            alt: 'ZHERP SVN 审查日志',
          },
        ]
      : [],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ZHERP SVN 审查日志',
    description: '每天的提交判断，沉淀为团队工程记忆。',
    images: socialImage ? [socialImage] : [],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeSwitcher />
        {children}
      </body>
    </html>
  );
}
