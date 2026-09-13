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
  title: 'SVN Review Hub',
  description: '多项目 SVN 审查日志与问题协作门户。',
  metadataBase: siteOrigin ? new URL(siteOrigin) : undefined,
  openGraph: {
    title: 'SVN Review Hub',
    description: '每天的提交判断，沉淀为团队工程记忆。',
    type: 'website',
    images: socialImage
      ? [
          {
            url: socialImage,
            width: 1200,
            height: 630,
            alt: 'SVN Review Hub',
          },
        ]
      : [],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SVN Review Hub',
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
    <html lang="zh-CN" data-theme="green">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeSwitcher />
        {children}
      </body>
    </html>
  );
}
